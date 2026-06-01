# Contributing

Thanks for helping ward grow. This guide covers the one thing contributors do most
often: **adding an operation**. Read the [README](./README.md) first — especially the
_Safety model_ and _Autonomy ladder_ — because every step below exists to keep those
guarantees true.

## What an operation is

An **operation** is one capability ward can perform against the substrate (the NUC),
exposed to the AI as a single [MCP](https://modelcontextprotocol.io) tool. Every
operation ward can ever run is declared in [`operations.yaml`](./operations.yaml) at the
repo root — the single source of truth for "what ward can do". Nothing outside that
allowlist is reachable.

Each operation has a **risk** class, and that class is what the guardrail gate keys on:

- **`read-only`** — observes; cannot change the substrate. Always allowed.
- **`mutating`** — changes the substrate. Forbidden at the default `read-only` autonomy
  floor (not even exposed as a tool), and at the `approval` level it does **not** run on
  request: it is _staged as a proposal_ and runs only when a human runs the separate
  `ward approve <id>` CLI in their own terminal. The AI has no approve tool, so it cannot
  approve its own proposal.

  | autonomy \ risk | read-only | mutating         |
  | --------------- | --------- | ---------------- |
  | `read-only`     | allow     | forbidden        |
  | `approval`      | allow     | require approval |

The structure of an operation lives in `operations.yaml`; its human/LLM-facing text
(title, description, and — for mutating ops — a plan) lives separately in the i18n label
files. Adding an operation is therefore a **3-file change**:

1. `operations.yaml` — the operation itself (name, risk, command).
2. `i18n/labels_en.yaml` — English labels.
3. `i18n/labels_ja.yaml` — Japanese labels.

## The injection-safety invariant

`command` is a **constant argv array**. The model supplies _no part_ of it — not even a
single argument — and it never runs through a shell (the executor uses `execFile`). There
is no string for the model to inject into.

The loader (`src/registry/operations.ts`) enforces this at startup and **fails closed** —
a malformed or unsafe registry makes the server throw before it can register any tool:

- `name` must match `^nuc_[a-z]+$` — the `nuc_` prefix, then lowercase letters only (no
  digits, no extra underscores in the suffix).
- `risk` must be exactly `read-only` or `mutating`.
- Every element of `command` (and of an optional `precheck`) must match
  `^[A-Za-z0-9_.-]+$` — letters, digits, `_`, `.`, `-`. **No spaces, no slashes, no shell
  metacharacters** (`;` `|` `$` `(` `)` `` ` `` …). This means you cannot pass a path like
  `/etc/hosts` or a quoted `sh -c "…"` string as an argument; each argv element is a bare
  token.
- Operation names must be unique.

If you need an argument the charset forbids, that is a signal to reconsider the operation
shape, not to widen the charset.

## Add an operation — worked example

Suppose you want to expose `docker version` as a read-only operation.

### 1. Declare it in `operations.yaml`

```yaml
- name: nuc_dockerversion
  risk: read-only
  command: [docker, version]
```

That is the whole structural change for a read-only op: a `name`, a `risk`, and a constant
`command` argv.

### 2. Add English labels in `i18n/labels_en.yaml`

Under the `ops:` map, keyed by the operation name:

```yaml
nuc_dockerversion:
  title: Docker version
  description: Returns the Docker client and server versions on the NUC (docker version).
```

### 3. Add Japanese labels in `i18n/labels_ja.yaml`

The **same keys**, translated:

```yaml
nuc_dockerversion:
  title: Docker バージョン
  description: NUC の Docker クライアント／サーバのバージョン（docker version）を返す。
```

That is it for a read-only operation.

### Mutating operations: also add a plan and a precheck

A `mutating` op needs two more things so a human can approve an _informed_ write rather
than a bare command string:

- **`precheck`** in `operations.yaml` — an optional read-only argv (same charset as
  `command`) the approver can run first to check current state. ward _shows_ it; it does
  not run it for you.
- **`plan`** under `ops.<name>` in **both** label files — a plain-language description of
  what will change.

Following the existing `nuc_pull` example:

```yaml
# operations.yaml
- name: nuc_pull
  risk: mutating
  command: [docker, pull, hello-world]
  precheck: [docker, images, hello-world]
```

```yaml
# i18n/labels_en.yaml — under ops:
nuc_pull:
  title: Pull image
  description: Pulls the Docker image hello-world onto the NUC (docker pull). A write operation that changes the NUC's disk state — it requires approval. Check the result with nuc_images.
  plan: Adds the hello-world image to the NUC's local Docker image store. If it is already present this only refreshes it — nothing else changes. Reversible with nuc_rmi.
```

```yaml
# i18n/labels_ja.yaml — under ops:
nuc_pull:
  title: イメージ取得
  description: NUC に Docker イメージ hello-world を取得する（docker pull）。NUC のディスク状態を変える書き込み操作——承認が要る。取得結果は nuc_images で確認できる。
  plan: hello-world イメージを NUC のローカル Docker イメージストアに追加する。既にあれば更新のみで他は変わらない。nuc_rmi で巻き戻せる。
```

A good `plan` says what changes, whether it is a no-op when already done, and how to roll
it back — see `nuc_pull` / `nuc_rmi`, which are each other's inverse.

## Bilingual rule

ward ships English and Japanese (English is the default; `WARD_LANG=ja` switches). **Every
label must exist in both `labels_en.yaml` and `labels_ja.yaml`.** A read-only op needs
`title` + `description` in both; a mutating op also needs `plan` in both. The test suite
enforces this parity — a label present in only one locale fails CI (see _Verify locally_).

## Verify locally

Run all four before opening a PR:

```bash
npm run typecheck   # tsc --noEmit
npm run lint        # eslint
npm test            # vitest run
npm run format      # prettier --write (then re-run format:check, or use the next line)
npm run format:check
```

The registry tests in `src/tests/registry/operations.test.ts` are what keep an operation
honest. They check that every op uses the `nuc_` name convention, has a known risk class,
has a constant command with no shell metacharacters, and — the parity guard — that **every
op has a `title` and `description` in every locale**, and **every mutating op has a `plan`
in every locale and a non-empty `precheck`**. The loader's own guards (unsafe argument,
unknown risk, duplicate name, fail-closed loading) are covered there too. If you forget a
Japanese label or use a forbidden character, these tests tell you exactly where.

## Submitting your change

ward follows trunk-based flow with no direct pushes to `main`:

```bash
git switch main && git pull
git switch -c feat/your-change
# ...edit the 3 files, verify locally...
git commit -m "feat: add nuc_dockerversion operation"
git push -u origin feat/your-change
gh pr create --base main
```

Keep commit messages in English, conventional-commit style. In the PR, state whether the
change touches the real NUC or is code/docs only.
