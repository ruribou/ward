import type { Operation, Proposal } from "../types.js";

/**
 * The pending-proposal store: the heart of the propose → approve gate.
 *
 * When a mutating operation is requested, ward does not run it — it stages a
 * {@link Proposal} here and hands back its id. A human then approves that id
 * (via the ward_approve tool), at which point the proposal is *consumed* and its
 * operation runs. So this store is the short-lived bridge between "AI proposed"
 * and "human approved": at most one approval per proposal, ever.
 *
 * Scope is the server process (one Claude Code session). Proposals are not meant
 * to outlive a restart — an unapproved proposal simply evaporates, which fails
 * safe (a forgotten proposal can never execute later). The durable, reviewable
 * record of what was proposed/executed lives in the audit log, not here.
 *
 * Security note: an id is an opaque handle the model passes to ward_approve. It
 * only ever *selects* a stored operation — it never becomes part of a command
 * (commands are constant argv from the registry). Combined with shape-validation
 * in {@link ProposalStore.consume}, a model-supplied id has no injection surface.
 */
export class ProposalStore {
  /** Matches the ids this store mints — used to reject malformed input early. */
  static readonly ID_RE = /^p[0-9]+$/;

  readonly #pending = new Map<string, Proposal>();
  #counter = 0;

  /** Stage a mutating operation and return its proposal, awaiting approval. */
  create(op: Operation): Proposal {
    const id = `p${++this.#counter}`;
    const proposal: Proposal = { id, op };
    this.#pending.set(id, proposal);
    return proposal;
  }

  /** Look up a pending proposal without consuming it (null if unknown). */
  get(id: string): Proposal | null {
    return this.#pending.get(id) ?? null;
  }

  /**
   * Approve an id: validate its shape, then remove and return its proposal so its
   * operation can run exactly once. Returns null for a malformed id, an unknown
   * id, or one that was already consumed — every "this should not execute" case.
   */
  consume(id: string): Proposal | null {
    if (!ProposalStore.ID_RE.test(id)) {
      return null;
    }
    const proposal = this.#pending.get(id) ?? null;
    if (proposal !== null) {
      this.#pending.delete(id);
    }
    return proposal;
  }
}
