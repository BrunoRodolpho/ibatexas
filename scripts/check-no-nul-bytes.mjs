#!/usr/bin/env node
/**
 * BKL-272 — raw NUL (0x00) guard for tracked text sources.
 *
 * WHY THIS EXISTS
 * A single raw 0x00 byte in a tracked source file makes `file(1)` classify it as
 * "data", and from that moment grep SILENTLY MATCHES NOTHING in it: `grep -I`
 * (and ripgrep's default) skip binary files entirely — exit 1, no output, no
 * error, indistinguishable from a genuine no-match. Plain `grep -n` is no better
 * for tooling: it prints "Binary file X matches" instead of a parseable
 * `file:line:content` row, so any line-oriented scanner sees nothing.
 *
 * This program's verification is heavily grep-shaped — the conformance
 * rule-inventory scanner over src/compiler/, count pins, drift mirrors,
 * stand-down checks — so one such file is a silent FALSE NEGATIVE hole across
 * all of it. Worse, git's binary heuristic only sniffs the first ~8KB: a NUL
 * past that offset diffs as ordinary text, so PR review sees nothing either.
 * (Of the seven NULs swept in BKL-272, four sat past 8KB and rendered as clean
 * text in the diff.)
 *
 * THE FIX IS ALWAYS CHEAP: write the escape sequence `\x00` instead of the raw
 * byte. In a TS/JS string or (untagged) template literal that is the exact same
 * runtime value — same string, same single UTF-8 byte, same hashes — while the
 * file on disk stays plain text and greppable. See PR #439 and BKL-272.
 *
 * DESIGN NOTES (BKL-249 trap)
 * The ci.yml `check` job installs almost nothing, so a gate that depends on an
 * optional binary skips itself and reports green while validating nothing. This
 * script therefore uses ONLY node builtins over `git ls-files` — no dependency,
 * no `skipIf` shape, no way to no-op silently. If it cannot enumerate tracked
 * files it exits non-zero rather than passing vacuously.
 *
 * SCOPE
 * Scans every tracked file EXCEPT those with a known-binary extension. This is
 * deliberately a denylist, not an allowlist of text extensions: a denylist means
 * a newly introduced text extension is covered automatically instead of opening
 * a fresh silent hole. If you add a genuinely binary asset with a new extension,
 * add it to BINARY_EXTENSIONS below — a loud failure you fix in one line is the
 * correct trade against an unnoticed grep-blind source file.
 *
 * Usage:  node scripts/check-no-nul-bytes.mjs
 * Exit 0 = clean. Exit 1 = offending file(s), each with byte offsets, on stderr.
 */

import { execFileSync } from "node:child_process"
import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs"
import { join, basename } from "node:path"

/** Extensions whose files are legitimately binary and are skipped unread. */
const BINARY_EXTENSIONS = new Set([
  // images
  "png", "jpg", "jpeg", "gif", "webp", "avif", "ico", "bmp", "tiff", "tif", "heic", "psd",
  // video / audio
  "mp4", "webm", "mov", "mkv", "avi", "mp3", "wav", "ogg", "flac", "m4a", "aac",
  // fonts
  "woff", "woff2", "ttf", "otf", "eot",
  // archives / documents
  "zip", "gz", "tgz", "bz2", "xz", "7z", "rar", "pdf",
  // compiled / opaque artifacts
  "wasm", "node", "so", "dylib", "dll", "exe", "bin", "class", "pyc", "jar",
  // databases / key material
  "db", "sqlite", "sqlite3", "p12", "pfx", "der", "keystore",
])

function extensionOf(path) {
  const base = basename(path)
  const dot = base.lastIndexOf(".")
  // dot at index 0 means a dotfile like `.gitignore` — no extension, scan it.
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : ""
}

/** Byte offset -> 1-based line/column, for a human-actionable message. */
function locate(buf, offset) {
  let line = 1
  let lineStart = 0
  for (let i = 0; i < offset; i++) {
    if (buf[i] === 0x0a) {
      line++
      lineStart = i + 1
    }
  }
  return { line, column: offset - lineStart + 1 }
}

function trackedFiles(repoRoot) {
  const out = execFileSync("git", ["ls-files", "-z"], {
    cwd: repoRoot,
    maxBuffer: 64 * 1024 * 1024,
  })
  return out.toString("utf8").split("\0").filter(Boolean)
}

function main() {
  const repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
    encoding: "utf8",
  }).trim()

  const files = trackedFiles(repoRoot)
  if (files.length === 0) {
    console.error("check-no-nul-bytes: `git ls-files` returned nothing — refusing to pass vacuously.")
    process.exit(1)
  }

  const offenders = []
  let scanned = 0
  let skipped = 0

  for (const rel of files) {
    if (BINARY_EXTENSIONS.has(extensionOf(rel))) {
      skipped++
      continue
    }
    const abs = join(repoRoot, rel)

    // Check and use must be the SAME OBJECT, not the same path. Stat-ing a path
    // and then reading that path is a TOCTOU race (CodeQL js/file-system-race):
    // the entry can be swapped between the two calls, so the file we vetted is
    // not necessarily the file we read. Everything below therefore happens on
    // one file descriptor — open once, fstat that fd, read that fd.
    //
    // O_NOFOLLOW refuses a symlink atomically at open() time (ELOOP), which is
    // strictly better than the old lstat-then-skip: there is no window in which
    // a regular file becomes a symlink. `?? 0` is belt-and-suspenders for a
    // platform whose fs.constants lacks the flag — it exists on darwin and
    // linux, which is everywhere this runs, CI included.
    let fd
    try {
      fd = openSync(abs, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    } catch {
      // ENOENT (listed but absent, e.g. sparse checkout), ELOOP (a symlink —
      // not ours to read), EACCES, or a directory/gitlink. Nothing to scan.
      continue
    }

    let buf
    try {
      // fstat on the descriptor cannot race: it describes the object we hold.
      if (!fstatSync(fd).isFile()) continue // directory / gitlink / fifo / device
      buf = readFileSync(fd) // same fd — never re-opened by path
    } finally {
      closeSync(fd)
    }
    scanned++

    const offsets = []
    for (let i = buf.indexOf(0); i !== -1; i = buf.indexOf(0, i + 1)) {
      offsets.push(i)
      if (offsets.length >= 20) break // enough to act on
    }
    if (offsets.length > 0) offenders.push({ rel, buf, offsets })
  }

  if (offenders.length > 0) {
    console.error("")
    console.error("FAIL: raw NUL (0x00) byte(s) found in tracked text source(s).")
    console.error("")
    console.error("A raw NUL makes `file` classify the source as binary; grep -I and ripgrep")
    console.error("then skip it silently (exit 1, no output), so every grep-shaped check in")
    console.error("this repo returns a FALSE NEGATIVE on it. Git's ~8KB binary heuristic also")
    console.error("lets a NUL past that offset diff as ordinary text, so review misses it too.")
    console.error("")
    console.error("FIX: replace the raw byte with the escape sequence \\x00. In a TS/JS string")
    console.error("or untagged template literal the runtime value is byte-identical.")
    console.error("")
    for (const { rel, buf, offsets } of offenders) {
      console.error(`  ${rel}`)
      for (const off of offsets) {
        const { line, column } = locate(buf, off)
        console.error(`      byte offset ${off} (line ${line}, column ${column})`)
      }
    }
    console.error("")
    console.error(
      `${offenders.length} file(s) affected. See BKL-272 / PR #439 for prior art.`,
    )
    console.error("")
    console.error(
      "If a listed file is a genuinely binary asset, add its extension to",
    )
    console.error("BINARY_EXTENSIONS in scripts/check-no-nul-bytes.mjs.")
    process.exit(1)
  }

  console.log(
    `check-no-nul-bytes: OK — ${scanned} tracked text file(s) scanned, ` +
      `${skipped} binary asset(s) skipped, 0 raw NUL bytes.`,
  )
}

main()
