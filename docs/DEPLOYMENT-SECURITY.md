# Deployment security

_日本語版: [DEPLOYMENT-SECURITY.ja.md](./DEPLOYMENT-SECURITY.ja.md)_

ward's guardrail is only as strong as the assumption underneath it: **the only path from
the AI to your infrastructure is ward.** This guide is the deployment-side half of that
guarantee. The [README](../README.md) describes the in-process guardrail (the gate, the
allowlist, out-of-band approval); this guide describes what _you_ must do when you deploy
ward so that guardrail cannot be walked around. Read the README's _Safety model_ first.

## The one rule

**Do not give the AI the substrate's credentials. ward must be the only door to your
infrastructure.**

Everything below is a consequence of this rule. ward checks every call against
`autonomy × risk` and stages writes for human approval — but those checks only matter if
ward is on the _only_ road to the substrate. If the AI's execution environment can reach
the machine some other way, it can simply take that other road, and the guardrail never
runs.

## Two honest caveats

ward's structure (the allowlist, the gate, the missing approve tool — see the README)
closes the case where the AI _accidentally_ self-approves. It does **not**, by itself,
close two paths that depend entirely on _how you deploy_:

1. **The AI can reach the substrate's credentials.** ward executes operations over SSH
   (`src/substrate/executor.ts`). If the SSH key and config live on the **same machine the
   AI's execution environment runs on**, the AI can run `ssh <host> …` directly from its
   own shell — past the allowlist, past the gate, past the audit log. ward is no longer the
   only door.

2. **Approval lives in the AI's reach.** Approval is a human CLI, `ward approve <id>`. The
   proposal store is a file, so proposer and approver are separate _processes_ — but if that
   CLI is reachable from the **same machine / same shell the AI can drive**, the AI can run
   `ward approve <id>` itself, collapsing back to self-approval. (In early live testing this
   held only because a human typed it; that is an operating convention, not a structural
   barrier.)

If either path is open, "a human approved this" is bypassable, and the guarantee is
conditional. Closing them is a deployment decision, not just a code decision.

## Deployment postures that close them

You close each caveat by putting it in a place the AI cannot reach. The structural fixes
(credential isolation, a separate approval trust domain) are tracked as future work in
[#31](https://github.com/ruribou/ward/issues/31); until they ship, these postures are how
you keep the guarantee true.

| Caveat                | What to do                                                                                                                                                                                                                           | Why it works                                                                            |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| Substrate credentials | Keep SSH / cloud credentials **out of the AI's execution environment**. Run ward — and the key it uses — where the AI's Bash tool cannot read or invoke it (a separate process, host, or account; an IAM role the AI does not hold). | The AI has no key to `ssh` with, so its only route to the substrate is a ward proposal. |
| Approval              | Approve **out-of-band**, in a trust domain the AI cannot reach: a different machine, or a push-to-approve channel — not the same shell the AI drives.                                                                                | The AI cannot run the approval step, so proposer and approver stay genuinely separate.  |
| Everything else       | Treat **ward as the sole path**. Do not add a side channel (a second SSH alias, a mounted key, a shared shell) that reaches the substrate without going through ward.                                                                | A guardrail with a bypass is not a guardrail.                                           |

A minimal safe posture today: the SSH key ward uses is not present in (and not invokable
from) the environment where the AI runs, and approval is performed by a human on a device
the AI has no access to. That keeps both doors closed without waiting for the structural
work.

## What ward guarantees today vs. what depends on deployment

**Guaranteed by ward's structure (regardless of deployment):**

- Only operations declared in [`operations.yaml`](../operations.yaml) are reachable through
  ward; nothing outside the allowlist.
- A mutating operation never runs on request. It is _staged as a proposal_ and runs only
  when consumed by `ward approve <id>` — the AI's MCP surface has no approve tool, so it
  cannot approve its own proposal through ward (the propose→approve split landed in
  [#28](https://github.com/ruribou/ward/issues/28)).
- Commands are constant argument vectors run without a shell; the model supplies no part of
  a command. Every proposal, execution, and rejection is recorded in the audit trail.

**Depends on _your_ deployment (not guaranteed by code yet):**

- That the AI **cannot bypass ward entirely** by using substrate credentials directly
  (caveat 1).
- That the AI **cannot run the approval step itself** because approval lives in a trust
  domain it cannot reach (caveat 2).

In short: ward makes the propose→approve gate _structural within its own surface_. Making
ward the _only_ surface is the deployment posture above — and the remaining structural
layers in [#31](https://github.com/ruribou/ward/issues/31).

## This generalizes beyond a single host

ward starts on a single host over SSH, but the isolation requirement is provider-agnostic.
When the substrate becomes AWS / GCP / Azure, "do not give the AI the credentials" becomes
"do not give the AI the cloud keys / IAM role," and "approve out-of-band" stays exactly the
same. The core is a breach-proof approval-and-guardrail plane the AI cannot route around —
the substrate underneath it changes, the rule does not.
