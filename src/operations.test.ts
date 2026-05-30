import { describe, expect, it } from "vitest";
import { operations } from "./operations.js";

describe("operations registry", () => {
  it("is non-empty and uniquely named", () => {
    expect(operations.length).toBeGreaterThan(0);
    const names = operations.map((o) => o.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("only contains read-only operations (the M1 invariant)", () => {
    for (const op of operations) {
      expect(op.risk).toBe("read-only");
    }
  });

  it("uses the nuc_ tool-name convention", () => {
    for (const op of operations) {
      expect(op.name).toMatch(/^nuc_[a-z]+$/);
    }
  });

  it("has constant commands with no shell metacharacters (no injection surface)", () => {
    for (const op of operations) {
      expect(op.command.length).toBeGreaterThan(0);
      for (const part of op.command) {
        expect(part).toMatch(/^[A-Za-z0-9_.-]+$/);
      }
    }
  });

  it("gives every operation a title and a description", () => {
    for (const op of operations) {
      expect(op.title.length).toBeGreaterThan(0);
      expect(op.description.length).toBeGreaterThan(0);
    }
  });
});
