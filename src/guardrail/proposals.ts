import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "../config.js";
import type { Operation, Proposal } from "../types.js";

/**
 * The pending-proposal store: the seam that makes approval *out of band*.
 *
 * When a mutating operation is requested, the MCP server does not run it — it
 * stages a {@link Proposal} here and hands back its id. The server (the AI's
 * surface) can ONLY write proposals; it has no approve tool. A human then runs
 * the separate `ward approve <id>` CLI, which *consumes* the proposal and runs
 * its operation exactly once. Proposer and approver are different processes, so
 * this store is backed by a file on disk — that shared file is the only thing
 * they have in common, and it is why the AI cannot approve its own proposal.
 *
 * Durability: because the approver runs later, in another process, proposals
 * MUST persist (they no longer evaporate with the server). An unapproved
 * proposal still cannot execute itself — only a human running `ward approve`
 * can. Stale proposals are listed by `ward list` and cleared by `ward reject`.
 * The durable, reviewable record of what was proposed/executed is the audit log.
 *
 * Security: an id is an opaque handle. It only ever *selects* a stored operation
 * — it never becomes part of a command (commands are constant argv from the
 * registry). {@link ProposalStore.consume} shape-validates the id, so a
 * caller-supplied id has no injection surface and cannot escape the store file.
 */
interface StoreState {
  counter: number;
  pending: Proposal[];
}

export class ProposalStore {
  /** Matches the ids this store mints — used to reject malformed input early. */
  static readonly ID_RE = /^p[0-9]+$/;

  readonly #path: string;

  constructor(path: string = config.proposalsFile) {
    this.#path = path;
  }

  #read(): StoreState {
    if (!existsSync(this.#path)) {
      return { counter: 0, pending: [] };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.#path, "utf8"));
    } catch (cause) {
      throw new Error(`ward: proposal store at ${this.#path} is corrupt`, { cause });
    }
    const state = parsed as Partial<StoreState>;
    return {
      counter: typeof state.counter === "number" ? state.counter : 0,
      pending: Array.isArray(state.pending) ? state.pending : [],
    };
  }

  /** Persist atomically (temp file + rename) so a crash never leaves a half-written store. */
  #write(state: StoreState): void {
    mkdirSync(dirname(this.#path), { recursive: true });
    const tmp = `${this.#path}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
    renameSync(tmp, this.#path);
  }

  /** Stage a mutating operation and return its proposal, awaiting human approval. */
  create(op: Operation): Proposal {
    const state = this.#read();
    const proposal: Proposal = { id: `p${++state.counter}`, op };
    state.pending.push(proposal);
    this.#write(state);
    return proposal;
  }

  /** All pending proposals, in creation order (for `ward list`). */
  list(): Proposal[] {
    return this.#read().pending;
  }

  /** Look up a pending proposal without consuming it (null if unknown). */
  get(id: string): Proposal | null {
    return this.#read().pending.find((p) => p.id === id) ?? null;
  }

  /**
   * Consume an id: validate its shape, then remove and return its proposal so its
   * operation can run exactly once. Returns null for a malformed id, an unknown
   * id, or one already consumed — every "this should not execute" case.
   */
  consume(id: string): Proposal | null {
    if (!ProposalStore.ID_RE.test(id)) {
      return null;
    }
    const state = this.#read();
    const index = state.pending.findIndex((p) => p.id === id);
    if (index === -1) {
      return null;
    }
    const [proposal] = state.pending.splice(index, 1);
    this.#write(state);
    return proposal ?? null;
  }
}
