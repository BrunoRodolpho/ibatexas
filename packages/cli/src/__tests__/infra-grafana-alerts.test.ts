// Wave-3: Grafana dashboard JSON + Prometheus alert YAML validation.
//
// Anti-theater rule (per the Wave-3 task brief, RULE 2): a JSON file alone is
// not evidence. This test:
//   1. Loads every Grafana dashboard JSON under `infra/grafana/dashboards/`,
//      parses it, asserts the panels[].targets[].expr is a string, that
//      datasource refs exist, that dashboard.uid is present, and that the
//      env templating variable is wired.
//   2. Loads `infra/alerts/kernel.yaml`, parses it, asserts each alert has
//      required fields (alert, expr, for, labels, annotations) and that every
//      metric name referenced in `expr` is in the canonical metric list (the
//      set already-emitted by `apps/api/src/plugins/kernel-metrics-sink.ts`
//      plus the new W3 metrics this rollout adds).
//
// Locale: this file lives in `packages/cli/src/__tests__/` because `cli` is
// the workspace that has `yaml` as a direct dependency (per `package.json`).
// The infra directory itself has no package.json on purpose — these are
// deployable artifacts, not a JS module.

import { describe, it, expect } from "vitest"
import { readFileSync, readdirSync } from "node:fs"
import { join, resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { parse as parseYaml } from "yaml"

const HERE = dirname(fileURLToPath(import.meta.url))
// __tests__ -> src -> cli -> packages -> repo root
const REPO_ROOT = resolve(HERE, "..", "..", "..", "..")
const DASHBOARDS_DIR = join(REPO_ROOT, "infra", "grafana", "dashboards")
const ALERTS_FILE = join(REPO_ROOT, "infra", "alerts", "kernel.yaml")

// ── Canonical metric list (W7-G4: programmatically derived) ────────────────
//
// RULE I (Wave 7 G4): the canonical list MUST be derived from the source
// of truth — `apps/api/src/plugins/kernel-metrics-sink.ts`. The previous
// hardcoded list silently admitted dashboard/alert references to metric
// names the sink never emitted (e.g., `kernel_audit_spill_bytes` was in
// the allow-set, masking the fact that the sink emits
// `kernel_audit_sink_spill_size`). A static allow-list is theatre — it
// only catches names that aren't in IT, not names that drift from the
// sink.
//
// Mechanism: parse the sink file at test load time and extract every
// `name: "kernel_..."` literal. Each metric definition in the sink uses
// the shape:
//
//     { name: "kernel_<thing>_total", help: "...", labelNames: [...] }
//
// so a regex over the file source recovers the canonical set. If the
// sink adds, removes, or renames a metric, this set updates automatically
// on the next test run.
//
// If a metric appears in a Grafana JSON or alert YAML but NOT in the
// programmatically-derived sink set, the test fails — that is the
// anti-theater guarantee.

const KERNEL_METRICS_SINK_PATH = resolve(
  REPO_ROOT,
  "apps",
  "api",
  "src",
  "plugins",
  "kernel-metrics-sink.ts",
)

function deriveCanonicalMetricsFromSink(): ReadonlySet<string> {
  const source = readFileSync(KERNEL_METRICS_SINK_PATH, "utf-8")
  // Match `name: "kernel_..."` — captures any kernel_ metric name declared
  // as a string literal in the file. Comment lines containing the same
  // shape are excluded by the leading non-`//` constraint (the regex is
  // applied after a comment-strip pass).
  const stripped = stripLineComments(source)
  const matches = stripped.matchAll(/\bname:\s*"(kernel_[a-zA-Z0-9_]+)"/g)
  const names = new Set<string>()
  for (const m of matches) {
    if (m[1]) names.add(m[1])
  }
  if (names.size === 0) {
    throw new Error(
      `kernel-metrics-sink.ts produced ZERO canonical metric names — parser broken or file moved?\n  path: ${KERNEL_METRICS_SINK_PATH}`,
    )
  }
  return names
}

/**
 * Strip `// ...` line comments from a TS source so regex-based metric-name
 * extraction doesn't accidentally pick up names mentioned in code comments.
 * Block comments (`/* ... *\/`) are left intact — the sink's metric-name
 * literals are never inside block comments.
 */
function stripLineComments(src: string): string {
  return src.replace(/^\s*\/\/.*$/gm, "")
}

const CANONICAL_METRICS: ReadonlySet<string> = deriveCanonicalMetricsFromSink()

/** Histogram metrics produce auto-generated _bucket / _count / _sum series. */
function isHistogramSuffix(name: string): boolean {
  return (
    name.endsWith("_bucket") || name.endsWith("_count") || name.endsWith("_sum")
  )
}

function stripHistogramSuffix(name: string): string {
  return name.replace(/_(bucket|count|sum)$/, "")
}

/** Returns true if a metric name (possibly with histogram suffix) is canonical. */
function isCanonicalMetric(name: string): boolean {
  if (CANONICAL_METRICS.has(name)) return true
  if (isHistogramSuffix(name)) {
    return CANONICAL_METRICS.has(stripHistogramSuffix(name))
  }
  return false
}

/**
 * Extract every `kernel_*` identifier from a PromQL expression. PromQL metric
 * names are `[a-zA-Z_:][a-zA-Z0-9_:]*` per the spec; we restrict the prefix to
 * `kernel_` because that's what the contract owns.
 */
function extractKernelMetrics(expr: string): string[] {
  const matches = expr.match(/\bkernel_[a-zA-Z0-9_]+/g) ?? []
  // Filter to whole-token matches (PromQL labels never have `kernel_` prefix
  // by convention in this project, so a regex sweep is fine).
  return Array.from(new Set(matches))
}

// ── Dashboard tests ──────────────────────────────────────────────────────────

interface GrafanaPanel {
  id?: number
  title?: string
  type?: string
  targets?: Array<{
    expr?: string
    refId?: string
    datasource?: { type?: string; uid?: string }
  }>
  datasource?: { type?: string; uid?: string }
}

interface GrafanaDashboard {
  uid?: string
  title?: string
  schemaVersion?: number
  refresh?: string
  templating?: { list?: Array<{ name?: string; type?: string }> }
  panels?: GrafanaPanel[]
}

function loadDashboard(file: string): GrafanaDashboard {
  const raw = readFileSync(file, "utf-8")
  return JSON.parse(raw) as GrafanaDashboard
}

describe("Grafana dashboards", () => {
  const files = readdirSync(DASHBOARDS_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => join(DASHBOARDS_DIR, f))

  it("contains exactly the three live kernel dashboards (enforcement-readiness retired with shadow mode)", () => {
    // kernel-enforcement-readiness.json was retired together with the
    // `kernel_shadow_divergence_total` metric when shadow mode was removed
    // (kernel is always authoritative — CLAUDE.md rule #9; see
    // kernel-metrics-sink.ts + commit 1024028). It only ever charted the
    // shadow→enforce divergence the always-on kernel no longer produces.
    const names = files.map((f) => f.split("/").pop()).sort()
    expect(names).toEqual([
      "kernel-audit-pipeline-health.json",
      "kernel-decision-overview.json",
      "kernel-defer-backlog.json",
    ])
  })

  for (const file of files) {
    const fileName = file.split("/").pop()!

    describe(fileName, () => {
      const dashboard = loadDashboard(file)

      it("parses as valid JSON", () => {
        expect(dashboard).toBeTypeOf("object")
      })

      it("has a uid and title", () => {
        expect(dashboard.uid).toBeTypeOf("string")
        expect(dashboard.uid!.length).toBeGreaterThan(0)
        expect(dashboard.title).toBeTypeOf("string")
      })

      it("uses Grafana 9.x/10.x schemaVersion", () => {
        expect(dashboard.schemaVersion).toBeTypeOf("number")
        // Grafana 9 ships schemaVersion 36-38; Grafana 10 ships 38-39.
        expect(dashboard.schemaVersion!).toBeGreaterThanOrEqual(36)
        expect(dashboard.schemaVersion!).toBeLessThanOrEqual(40)
      })

      it("has a reasonable refresh interval (<= 1m)", () => {
        // Allowed: 30s, 1m
        expect(["30s", "1m"]).toContain(dashboard.refresh)
      })

      it("declares an `env` templating variable", () => {
        const vars = dashboard.templating?.list ?? []
        const envVar = vars.find((v) => v.name === "env")
        expect(envVar, `${fileName} must declare env templating var`).toBeDefined()
      })

      it("declares a Prometheus datasource templating variable", () => {
        const vars = dashboard.templating?.list ?? []
        const ds = vars.find((v) => v.type === "datasource")
        expect(ds, `${fileName} must declare a datasource variable`).toBeDefined()
      })

      it("has at least one panel", () => {
        expect(dashboard.panels?.length ?? 0).toBeGreaterThan(0)
      })

      it("every panel has targets with string `expr` and a datasource ref", () => {
        const panels = dashboard.panels ?? []
        for (const panel of panels) {
          // Skip non-data panels (rows, text panels) — they have no targets
          if (panel.type === "row" || panel.type === "text") continue
          expect(panel.targets, `panel ${panel.id} has no targets`).toBeDefined()
          for (const t of panel.targets!) {
            expect(t.expr, `panel ${panel.id} target ${t.refId} expr missing`)
              .toBeTypeOf("string")
            expect(t.expr!.length).toBeGreaterThan(0)
            expect(
              t.datasource?.uid,
              `panel ${panel.id} target ${t.refId} datasource uid missing`,
            ).toBeTypeOf("string")
          }
        }
      })

      it("every PromQL expr references only canonical kernel_* metrics", () => {
        const panels = dashboard.panels ?? []
        const offenders: string[] = []
        for (const panel of panels) {
          for (const t of panel.targets ?? []) {
            if (!t.expr) continue
            for (const metric of extractKernelMetrics(t.expr)) {
              if (!isCanonicalMetric(metric)) {
                offenders.push(`panel ${panel.id} (${panel.title}): ${metric}`)
              }
            }
          }
        }
        expect(
          offenders,
          `unknown metrics referenced:\n${offenders.join("\n")}`,
        ).toEqual([])
      })
    })
  }
})

// ── Alert tests ──────────────────────────────────────────────────────────────

interface AlertRule {
  alert?: string
  expr?: string
  for?: string
  labels?: Record<string, string>
  annotations?: Record<string, string>
}

interface AlertGroup {
  name?: string
  interval?: string
  rules?: AlertRule[]
}

interface AlertFile {
  groups?: AlertGroup[]
}

describe("Prometheus alert rules", () => {
  const raw = readFileSync(ALERTS_FILE, "utf-8")
  const parsed = parseYaml(raw) as AlertFile

  it("is a valid YAML document with `groups`", () => {
    expect(parsed.groups).toBeInstanceOf(Array)
    expect(parsed.groups!.length).toBeGreaterThan(0)
  })

  it("declares exactly 11 rules (13 minus the 2 shadow-divergence alerts retired with shadow mode)", () => {
    // The KernelDivergenceDecisionKind + KernelDivergencePayloadRewrite
    // alerts were retired with the `kernel_shadow_divergence_total` metric
    // (shadow mode removed — CLAUDE.md rule #9; commit 1024028).
    const totalRules = (parsed.groups ?? []).reduce(
      (acc, g) => acc + (g.rules?.length ?? 0),
      0,
    )
    expect(totalRules).toBe(11)
  })

  it("every rule has alert / expr / for / labels / annotations", () => {
    for (const group of parsed.groups ?? []) {
      for (const rule of group.rules ?? []) {
        expect(rule.alert, `rule missing alert name`).toBeTypeOf("string")
        expect(rule.expr, `rule ${rule.alert} missing expr`).toBeTypeOf("string")
        expect(rule.for, `rule ${rule.alert} missing for`).toBeTypeOf("string")
        expect(
          rule.labels?.severity,
          `rule ${rule.alert} missing labels.severity`,
        ).toMatch(/^S[12]$/)
        expect(rule.labels?.team, `rule ${rule.alert} missing labels.team`).toBe(
          "kernel",
        )
        expect(
          rule.annotations?.summary,
          `rule ${rule.alert} missing annotations.summary`,
        ).toBeTypeOf("string")
        expect(
          rule.annotations?.description,
          `rule ${rule.alert} missing annotations.description`,
        ).toBeTypeOf("string")
        expect(
          rule.annotations?.runbook_url,
          `rule ${rule.alert} missing annotations.runbook_url`,
        ).toMatch(/^https?:\/\//)
      }
    }
  })

  it("every expr references only canonical kernel_* metrics", () => {
    const offenders: string[] = []
    for (const group of parsed.groups ?? []) {
      for (const rule of group.rules ?? []) {
        if (!rule.expr) continue
        for (const metric of extractKernelMetrics(rule.expr)) {
          if (!isCanonicalMetric(metric)) {
            offenders.push(`${rule.alert}: ${metric}`)
          }
        }
      }
    }
    expect(
      offenders,
      `unknown metrics referenced:\n${offenders.join("\n")}`,
    ).toEqual([])
  })

  it("rule names follow the KernelXxxYyy PascalCase convention", () => {
    for (const group of parsed.groups ?? []) {
      for (const rule of group.rules ?? []) {
        expect(
          rule.alert,
          `rule alert name should be Kernel-prefixed PascalCase`,
        ).toMatch(/^Kernel[A-Z][a-zA-Z]+$/)
      }
    }
  })
})
