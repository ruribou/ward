import { describe, expect, it } from "vitest";
import { ProposalStore } from "../../guardrail/proposals.js";
import type { Operation } from "../../types.js";

const op: Operation = {
  name: "nuc_reboot",
  title: "t",
  description: "d",
  risk: "mutating",
  command: ["sudo", "reboot"],
};

describe("ProposalStore", () => {
  it("mints monotonically increasing ids", () => {
    const store = new ProposalStore();
    expect(store.create(op).id).toBe("p1");
    expect(store.create(op).id).toBe("p2");
  });

  it("returns a stored proposal via get without consuming it", () => {
    const store = new ProposalStore();
    const { id } = store.create(op);
    expect(store.get(id)?.op).toBe(op);
    expect(store.get(id)?.op).toBe(op);
  });

  it("returns null from get for an unknown id", () => {
    expect(new ProposalStore().get("p999")).toBeNull();
  });

  it("consume returns the proposal exactly once (one-time use)", () => {
    const store = new ProposalStore();
    const { id } = store.create(op);
    expect(store.consume(id)?.op).toBe(op);
    expect(store.consume(id)).toBeNull();
  });

  it("consume rejects an unknown id", () => {
    expect(new ProposalStore().consume("p999")).toBeNull();
  });

  it("consume rejects a malformed id without throwing, leaving real proposals intact", () => {
    const store = new ProposalStore();
    store.create(op);
    for (const bad of ["../etc", "p1; rm -rf /", "", "P1", "1"]) {
      expect(store.consume(bad)).toBeNull();
    }
    expect(store.consume("p1")?.op).toBe(op);
  });
});
