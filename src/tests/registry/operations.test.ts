import { describe, expect, it } from "vitest";
import { OperationLoadError, operations, parseOperations } from "../../registry/operations.js";

describe("operations registry", () => {
  it("is non-empty and uniquely named", () => {
    expect(operations.length).toBeGreaterThan(0);
    const names = operations.map((o) => o.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("classifies every operation as a known risk class", () => {
    for (const op of operations) {
      expect(["read-only", "mutating"]).toContain(op.risk);
    }
  });

  it("now includes the first mutating operations behind the approval gate", () => {
    const mutating = operations.filter((o) => o.risk === "mutating").map((o) => o.name);
    expect(mutating).toContain("nuc_pull");
    expect(mutating).toContain("nuc_rmi");
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

describe("parseOperations (the loader guardrail)", () => {
  const valid = `
operations:
  - name: nuc_uptime
    title: t
    description: d
    risk: read-only
    command: [uptime]
`;

  it("loads a well-formed registry", () => {
    const ops = parseOperations(valid);
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ name: "nuc_uptime", command: ["uptime"] });
  });

  it("rejects a command argument with a shell metacharacter", () => {
    const yaml = `
operations:
  - name: nuc_pwn
    title: t
    description: d
    risk: read-only
    command: [sh, -c, "rm -rf /"]
`;
    expect(() => parseOperations(yaml)).toThrow(OperationLoadError);
  });

  it("rejects a path argument (slash is not in the safe charset)", () => {
    const yaml = `
operations:
  - name: nuc_cat
    title: t
    description: d
    risk: read-only
    command: [cat, /etc/shadow]
`;
    expect(() => parseOperations(yaml)).toThrow(/unsafe argument/);
  });

  it("rejects an unknown risk class", () => {
    const yaml = `
operations:
  - name: nuc_uptime
    title: t
    description: d
    risk: yolo
    command: [uptime]
`;
    expect(() => parseOperations(yaml)).toThrow(/risk must be one of/);
  });

  it("rejects an empty registry", () => {
    expect(() => parseOperations("operations: []")).toThrow(OperationLoadError);
  });

  it("rejects duplicate operation names", () => {
    const yaml = `
operations:
  - { name: nuc_uptime, title: t, description: d, risk: read-only, command: [uptime] }
  - { name: nuc_uptime, title: t, description: d, risk: read-only, command: [uptime] }
`;
    expect(() => parseOperations(yaml)).toThrow(/duplicate/);
  });
});
