# ward

> Operate your home infrastructure safely, in natural language, via Claude Code.

_日本語版: [README.ja.md](./README.ja.md)_

**ward** lets an AI agent (Claude, through [Claude Code](https://claude.com/claude-code))
run real operations on your home infrastructure — checking disk, listing containers,
pulling an image — by exposing them as [MCP](https://modelcontextprotocol.io) tools.

The hard part isn't connecting an AI to a machine. It's deciding **how much autonomy
to grant, and how to contain a mistake when it happens.** ward is built around that
question: every operation passes through a guardrail before it can touch anything, and
autonomy is released one deliberate step at a time — read-only first, human-approved
next, fully autonomous only later.

## The name — why _ward_

The word says what the project is, twice over:

- **ward (verb) — to fend off.** To _ward off_ accidents: contain the blast radius
  with guardrails.
- **ward (noun) — one under guardianship.** The agent is kept under close supervision
  at first, and granted more autonomy only as it earns trust — a _ward_ in the legal
  sense.

Taken as initials: **W**atched **A**utonomy, **R**eversible **D**eployment — the two
pillars the project is built on.

## Safety model

ward is read-only by default and assumes nothing about the agent's good behavior. The
guarantees come from structure, not trust:

- **One source of truth.** Every operation ward can perform is declared in
  [`operations.yaml`](./operations.yaml) as a fixed command with a `risk` level.
  Nothing outside that allowlist is reachable.
- **A guardrail gate.** Every call is checked against `autonomy level × risk` before it
  runs:

  | autonomy \ risk | read-only | mutating         |
  | --------------- | --------- | ---------------- |
  | `read-only`     | allow     | forbidden        |
  | `approval`      | allow     | require approval |

- **A read-only floor.** The default level is `read-only`. At this level mutating
  operations aren't even exposed as tools — the agent never sees a write it could
  attempt.
- **Propose → approve for writes.** At the `approval` level a mutating operation does
  not run on request. It is _staged as a proposal_; a separate approval step executes
  it. The model cannot perform a write in a single move — a human is structurally in
  the loop.
- **Constant commands, no shell.** Commands run as fixed argument vectors (never through
  a shell), and the model supplies _no part_ of the command — not even an argument.
  There is no string for it to inject into.
- **An append-only audit trail.** What was proposed and what was executed is recorded so
  every action stays reviewable and reversible.

## Autonomy ladder

ward widens what the agent may do one rung at a time. Moving up is a configuration
change, not a rewrite:

1. **`read-only`** _(default)_ — observe only. Cannot change the substrate.
2. **`approval`** — may _propose_ changes; a human approves each one before it runs.
3. **`autonomous`** — act within policy without per-action approval. **Not built yet.**

## Status

Early and evolving. Progress so far:

- **M1** — read-only status over MCP
- **M2** — operations declared in a YAML registry
- **M3** — approval gate and the first mutating operations
- **i18n** — bilingual tool text and messages (English default, `WARD_LANG=ja`)

**Install & quickstart docs are coming** as the interface settles. Until then the
[issues](https://github.com/ruribou/ward/issues) track what's planned.

## License

[MIT](./LICENSE)
