import { describe, expect, it } from "vitest";
import { guard, GuardrailError } from "../../guardrail/guard.js";
import { operations } from "../../registry/operations.js";
import type { Operation } from "../../types.js";

const mutating: Operation = {
  name: "nuc_reboot",
  title: "(test) reboot",
  description: "(test) a hypothetical mutating operation",
  risk: "mutating",
  command: ["sudo", "reboot"],
};

describe("guard", () => {
  it("allows every operation in the registry at the read-only level (all read-only)", () => {
    for (const op of operations) {
      expect(guard(op, "read-only")).toBe("allow");
    }
  });

  it("allows a read-only operation at the approval level too", () => {
    expect(guard(operations[0]!, "approval")).toBe("allow");
  });

  it("forbids a mutating operation outright at the read-only level", () => {
    expect(() => guard(mutating, "read-only")).toThrow(GuardrailError);
  });

  it("names the offending operation and its risk in the forbidden error", () => {
    expect(() => guard(mutating, "read-only")).toThrow(/nuc_reboot.*mutating/);
  });

  it("gates a mutating operation behind approval at the approval level", () => {
    expect(guard(mutating, "approval")).toBe("require-approval");
  });
});
