import { describe, expect, it } from "vitest";
import { guard, GuardrailError } from "../../guardrail/guard.js";
import { operations } from "../../registry/operations.js";
import type { Operation } from "../../types.js";

const mutating: Operation = {
  name: "nuc_reboot",
  risk: "mutating",
  command: ["sudo", "reboot"],
};

describe("guard", () => {
  it("allows every read-only operation in the registry at the read-only level", () => {
    for (const op of operations.filter((o) => o.risk === "read-only")) {
      expect(guard(op, "read-only")).toBe("allow");
    }
  });

  it("forbids the registry's real mutating operations at the read-only level", () => {
    const mutating = operations.filter((o) => o.risk === "mutating");
    expect(mutating.length).toBeGreaterThan(0);
    for (const op of mutating) {
      expect(() => guard(op, "read-only")).toThrow(GuardrailError);
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
