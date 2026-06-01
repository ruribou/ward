import { describe, expect, it } from "vitest";
import { decide, parsePolicy, PolicyLoadError, type PolicyData } from "../../guardrail/policy.js";

const DEFAULTS = `
defaults:
  read-only:
    read-only: allow
    mutating: deny
  approval:
    read-only: allow
    mutating: require-approval
`;
const VALID = `${DEFAULTS}overrides: {}\n`;
const withOverrides = (body: string) => `${DEFAULTS}overrides:\n${body}`;

describe("parsePolicy", () => {
  it("parses a complete policy into defaults and overrides", () => {
    const p = parsePolicy(VALID);
    expect(p.defaults["read-only"]).toEqual({ "read-only": "allow", mutating: "deny" });
    expect(p.defaults.approval).toEqual({ "read-only": "allow", mutating: "require-approval" });
    expect(p.overrides).toEqual({});
  });

  it("treats a missing overrides block as empty", () => {
    const p = parsePolicy(VALID.replace("overrides: {}", ""));
    expect(p.overrides).toEqual({});
  });

  it("parses per-op overrides keyed by op then level", () => {
    const p = parsePolicy(withOverrides("  nuc_pull:\n    approval: deny\n"));
    expect(p.overrides.nuc_pull).toEqual({ approval: "deny" });
  });

  it.each([
    ["a non-mapping root", "[]"],
    ["a missing defaults block", "overrides: {}"],
    [
      "a missing risk cell",
      "defaults:\n  read-only:\n    read-only: allow\n  approval:\n    read-only: allow\n    mutating: require-approval\n",
    ],
    [
      "an unknown decision value",
      "defaults:\n  read-only:\n    read-only: maybe\n    mutating: deny\n  approval:\n    read-only: allow\n    mutating: require-approval\n",
    ],
    [
      "an unknown autonomy level",
      "defaults:\n  autonomous:\n    read-only: allow\n    mutating: allow\n  read-only:\n    read-only: allow\n    mutating: deny\n  approval:\n    read-only: allow\n    mutating: require-approval\n",
    ],
    [
      "an unknown risk class",
      "defaults:\n  read-only:\n    read-only: allow\n    mutating: deny\n    destructive: allow\n  approval:\n    read-only: allow\n    mutating: require-approval\n",
    ],
    ["an unknown level in an override", withOverrides("  nuc_pull:\n    autonomous: allow\n")],
  ])("fails closed on %s", (_label, yaml) => {
    expect(() => parsePolicy(yaml)).toThrow(PolicyLoadError);
  });
});

describe("decide", () => {
  const p = parsePolicy(VALID);

  it("applies the default matrix", () => {
    expect(decide(p, "read-only", "read-only", "nuc_disk")).toBe("allow");
    expect(decide(p, "read-only", "mutating", "nuc_pull")).toBe("deny");
    expect(decide(p, "approval", "read-only", "nuc_disk")).toBe("allow");
    expect(decide(p, "approval", "mutating", "nuc_pull")).toBe("require-approval");
  });

  it("lets a per-op override win over the default", () => {
    const withOverride = parsePolicy(withOverrides("  nuc_pull:\n    approval: deny\n"));
    expect(decide(withOverride, "approval", "mutating", "nuc_pull")).toBe("deny");
    // a different op is unaffected
    expect(decide(withOverride, "approval", "mutating", "nuc_rmi")).toBe("require-approval");
  });

  it("denies anything the policy does not cover (fail-closed)", () => {
    // An autonomy level the policy never declares decides to deny.
    expect(decide(p, "autonomous" as never, "read-only", "nuc_disk")).toBe("deny");
    const empty: PolicyData = { defaults: {}, overrides: {} };
    expect(decide(empty, "approval", "read-only", "nuc_disk")).toBe("deny");
  });
});
