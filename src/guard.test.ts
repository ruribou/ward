import { describe, expect, it } from "vitest";
import { guard, GuardrailError } from "./guard.js";
import { operations } from "./operations.js";
import type { Operation } from "./types.js";

describe("guard", () => {
  it("allows every operation in the registry (all read-only)", () => {
    for (const op of operations) {
      expect(() => guard(op)).not.toThrow();
    }
  });

  it("rejects a mutating operation at the read-only autonomy level", () => {
    const mutating: Operation = {
      name: "nuc_reboot",
      title: "(test) reboot",
      description: "(test) a hypothetical mutating operation",
      risk: "mutating",
      command: ["sudo", "reboot"],
    };
    expect(() => guard(mutating)).toThrow(GuardrailError);
  });

  it("names the offending operation and its risk in the error message", () => {
    const mutating: Operation = {
      name: "nuc_rm",
      title: "(test)",
      description: "(test)",
      risk: "mutating",
      command: ["rm", "-rf", "/tmp/x"],
    };
    expect(() => guard(mutating)).toThrow(/nuc_rm.*mutating/);
  });
});
