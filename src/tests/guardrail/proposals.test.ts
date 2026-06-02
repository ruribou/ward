import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ProposalStore } from "../../guardrail/proposals.js";
import type { Operation } from "../../types.js";

const op: Operation = {
  name: "sys_reboot",
  risk: "mutating",
  command: ["sudo", "reboot"],
};

// File-backed: each test gets its own temp store file, cleaned up afterward.
let counter = 0;
let path: string;
let store: ProposalStore;

beforeEach(() => {
  counter += 1;
  path = join(tmpdir(), `ward-proposals-test-${process.pid}-${counter}.json`);
  store = new ProposalStore(path);
});

afterEach(() => {
  rmSync(path, { force: true });
  rmSync(`${path}.tmp`, { force: true });
});

describe("ProposalStore (file-backed)", () => {
  it("mints monotonically increasing ids", () => {
    expect(store.create(op).id).toBe("p1");
    expect(store.create(op).id).toBe("p2");
  });

  it("returns a stored proposal via get without consuming it", () => {
    const { id } = store.create(op);
    expect(store.get(id)?.op).toEqual(op);
    expect(store.get(id)?.op).toEqual(op);
  });

  it("lists pending proposals in creation order", () => {
    store.create(op);
    store.create(op);
    expect(store.list().map((p) => p.id)).toEqual(["p1", "p2"]);
  });

  it("returns null from get for an unknown id", () => {
    expect(store.get("p999")).toBeNull();
  });

  it("consume returns the proposal exactly once (one-time use)", () => {
    const { id } = store.create(op);
    expect(store.consume(id)?.op).toEqual(op);
    expect(store.consume(id)).toBeNull();
  });

  it("consume rejects an unknown id", () => {
    expect(store.consume("p999")).toBeNull();
  });

  it("consume rejects a malformed id without throwing, leaving real proposals intact", () => {
    store.create(op);
    for (const bad of ["../etc", "p1; rm -rf /", "", "P1", "1"]) {
      expect(store.consume(bad)).toBeNull();
    }
    expect(store.consume("p1")?.op).toEqual(op);
  });

  it("persists across instances — a separate process can list, approve, and keep the counter", () => {
    store.create(op); // p1, written to disk

    // A fresh instance at the same path (stands in for the `ward` CLI process).
    const other = new ProposalStore(path);
    expect(other.list().map((p) => p.id)).toEqual(["p1"]);
    expect(other.create(op).id).toBe("p2"); // counter survived
    expect(other.consume("p1")?.op).toEqual(op);

    // And the original handle sees the consumption.
    expect(store.get("p1")).toBeNull();
    expect(store.list().map((p) => p.id)).toEqual(["p2"]);
  });
});
