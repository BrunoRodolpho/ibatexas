# Claude Code Plugins

Plugins extend Claude's capabilities during development sessions.
They are installed globally (`~/.claude/plugins/`) and persist across sessions and projects.

---

## Installed Plugins

| Plugin | Installs | Purpose | Trigger |
|--------|----------|---------|---------|
| `frontend-design` | 277k+ | Production-grade UI design — avoids generic "AI slop" aesthetics | Auto on frontend work |
| `security-guidance` | — | Passive security pattern detection on every file edit | `PreToolUse` hook (auto) |
| `code-review` | 129k+ | Confidence-scored PR review with 5 parallel specialist agents | `/code-review` |
| `feature-dev` | 106k+ | 7-phase structured feature development with agents | `/feature-dev` |

---

## Usage

### `frontend-design`

Auto-triggers when working on UI components, pages, or layouts. Produces distinctive, brand-consistent designs with intentional aesthetic direction.

**IbateXas scope:** `apps/web` (storefront), `apps/admin` (dashboard), `packages/ui` (shared components).

### `security-guidance`

Runs passively as a `PreToolUse` hook on every `Edit`, `Write`, and `MultiEdit`. Catches security anti-patterns in real-time — zero workflow friction.

**IbateXas scope:** Auth flows (Twilio OTP + JWT), payment handling (Stripe + PIX), LGPD compliance, API input validation.

### `code-review`

Invoke with `/code-review` on a PR. Launches 5 parallel specialist agents that review from different angles (CLAUDE.md adherence, bug detection, git history, prior PR comments, code comments). Results are confidence-scored (0–100) and only issues scoring ≥80 are reported.

**IbateXas scope:** Compensates for solo development — automated peer review with severity scoring.

### `feature-dev`

Invoke with `/feature-dev [description]`. Guides feature development through 7 phases: Discovery → Codebase Understanding → Architecture Design → Clarification → Implementation → Testing → Review.

**IbateXas scope:** Complex remaining work — JetStream migration (EVT-001), auth layer formalization (ARCH-001), distributed tracing (OBS-001).

---

## Installing Plugins

```bash
# Install from official marketplace
claude plugin install frontend-design
claude plugin install security-guidance
claude plugin install code-review
claude plugin install feature-dev
```

> Restart your Claude Code session after installing for hooks and skills to activate.

## Managing Plugins

```bash
# List installed plugins
claude plugin list

# Install a plugin
claude plugin install <name>

# Uninstall a plugin
claude plugin uninstall <name>

# Enable/disable without uninstalling
claude plugin enable <name>
claude plugin disable <name>

# Update a plugin
claude plugin update <name>

# Update marketplace cache
claude plugin marketplace update

# Validate a plugin
claude plugin validate <path>
```

## Plugin Anatomy

Plugins live in `~/.claude/plugins/marketplaces/{marketplace}/plugins/{name}/` and can contain:

| Component | File | Purpose |
|-----------|------|---------|
| Skills | `skills/{name}/SKILL.md` | Prompt templates triggered by context or command |
| Commands | `commands/{name}.md` | Slash commands (`/command-name`) |
| Hooks | `hooks/hooks.json` + scripts | Event-based triggers (`PreToolUse`, `SessionStart`, etc.) |
| Agents | `agents/{name}.md` | Specialized sub-agents for the plugin's workflow |
