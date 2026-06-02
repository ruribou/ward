# ward

> Operate your home infrastructure safely, in natural language, via Claude Code.

_日本語版: [docs/README.ja.md](./docs/README.ja.md)_

**ward** lets an AI agent (Claude, through [Claude Code](https://claude.com/claude-code))
run real operations on your home infrastructure — checking disk, listing containers,
pulling an image — by exposing them as [MCP](https://modelcontextprotocol.io) tools.

That said, ward is about more than just connecting an AI to a machine. How much to hand
off — and how to keep the damage small if something goes wrong — is what it cares about
most. So every operation goes through a guardrail, and autonomy opens up gradually,
not all at once.

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
- **Out-of-band approval for writes.** At the `approval` level a mutating operation does
  not run on request. It is _staged as a proposal_; the only thing that executes it is a
  human running the separate `ward approve <id>` CLI in their own terminal. The agent's
  MCP surface has _no approve tool_, so it cannot approve its own proposal — approval
  happens in a process the agent does not drive. (This holds as long as the agent isn't
  also handed direct credentials to the substrate; making ward the only door is a further
  layer — see [docs/DEPLOYMENT-SECURITY.md](./docs/DEPLOYMENT-SECURITY.md).)
- **A plan with every proposal.** A proposal shows more than the command: a plain-language
  description of what will change, and a read-only command you can run first to check the
  current state — so approval is _informed_, not a rubber stamp. Building the plan never
  touches the host.
- **Constant commands, no shell.** Commands run as fixed argument vectors (never through
  a shell), and the model supplies _no part_ of the command — not even an argument.
  There is no string for it to inject into.
- **An append-only audit trail.** What was proposed, executed, and rejected is recorded so
  every action stays reviewable and reversible. `ward metrics` summarizes that trail into
  the guardrail numbers — success rate, human-intervention rate, proposal resolution
  (approved / rejected / pending), and blast radius.

## Autonomy ladder

ward widens what the agent may do one rung at a time. Moving up is a configuration
change, not a rewrite:

1. **`read-only`** _(default)_ — observe only. Cannot change the substrate.
2. **`approval`** — may _propose_ changes; a human approves each one before it runs.
3. **`autonomous`** — act within policy without per-action approval. **Not built yet.**

## Configuration

User preferences live in a config file (`~/.ward/config.yaml`), with an env var as a
per-process override. Precedence is **env > file > built-in default**, so an env var
always wins for a single run while the file is the persistent setting shared by both the
MCP server and the `ward` CLI.

Two keys are settable:

- **`language`** — UI language (`en` default, or `ja`). Env override: `WARD_LANG`.
- **`ssh_host`** — the SSH host **alias** (env override: `WARD_SSH_HOST`).

```yaml
# ~/.ward/config.yaml
language: ja
ssh_host: nuc
```

Set them from the CLI (which writes the file for you):

```sh
ward config set language ja
ward config set ssh_host nuc
ward config get           # show stored values and the file path
ward config path          # print the resolved config file path
```

> **`ssh_host` is an alias only — never a real IP or hostname.** ward resolves it through
> your `~/.ssh/config`, where the real address stays; the alias is all that is written to
> `~/.ward/config.yaml`. ward enforces this: a value with spaces, colons, or slashes is
> rejected.

`autonomy` is deliberately **not** file-configurable — it is a guardrail attribute, set
only via `WARD_AUTONOMY`, so loosening it is always an explicit act rather than a quiet
edit to a dotfile.

## Status

Early and evolving. Progress so far:

- **M1** — read-only status over MCP
- **M2** — operations declared in a YAML registry
- **M3** — approval gate and the first mutating operations
- **i18n** — bilingual tool text and messages (English default), configurable via the
  config file (`language: ja`) or `WARD_LANG`

**Install & quickstart docs are coming** as the interface settles. Until then the
[issues](https://github.com/ruribou/ward/issues) track what's planned.

## Contributing

Adding an operation is a small, reviewable change. See [docs/CONTRIBUTING.md](./docs/CONTRIBUTING.md)
for the step-by-step recipe and the safety invariants it must keep.

## License

[MIT](./LICENSE)
