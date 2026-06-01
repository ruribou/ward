import { describe, expect, it } from "vitest";
import { LOCALES } from "../../config.js";
import { getLabel } from "../../i18n/index.js";
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

  it("has a title and description label in every locale for every operation", () => {
    for (const op of operations) {
      for (const locale of LOCALES) {
        expect(getLabel(`ops.${op.name}.title`, locale).length).toBeGreaterThan(0);
        expect(getLabel(`ops.${op.name}.description`, locale).length).toBeGreaterThan(0);
      }
    }
  });

  it("gives every mutating op a plan: an effect description (both locales) and a precheck", () => {
    for (const op of operations.filter((o) => o.risk === "mutating")) {
      for (const locale of LOCALES) {
        expect(getLabel(`ops.${op.name}.plan`, locale).length).toBeGreaterThan(0);
      }
      expect(op.precheck?.length ?? 0).toBeGreaterThan(0);
    }
  });
});

describe("parseOperations (the loader guardrail)", () => {
  const valid = `
operations:
  - name: nuc_uptime
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
    risk: read-only
    command: [sh, -c, "rm -rf /"]
`;
    expect(() => parseOperations(yaml)).toThrow(OperationLoadError);
  });

  it("rejects a path argument (slash is not in the safe charset)", () => {
    const yaml = `
operations:
  - name: nuc_cat
    risk: read-only
    command: [cat, /etc/shadow]
`;
    expect(() => parseOperations(yaml)).toThrow(/unsafe argument/);
  });

  it("rejects an unknown risk class", () => {
    const yaml = `
operations:
  - name: nuc_uptime
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
  - { name: nuc_uptime, risk: read-only, command: [uptime] }
  - { name: nuc_uptime, risk: read-only, command: [uptime] }
`;
    expect(() => parseOperations(yaml)).toThrow(/duplicate/);
  });

  it("loads an optional precheck and validates it like command", () => {
    const yaml = `
operations:
  - name: nuc_pull
    risk: mutating
    command: [docker, pull, hello-world]
    precheck: [docker, images, hello-world]
`;
    expect(parseOperations(yaml)[0]?.precheck).toEqual(["docker", "images", "hello-world"]);
  });

  it("treats precheck as optional (absent leaves it undefined)", () => {
    expect(parseOperations(valid)[0]?.precheck).toBeUndefined();
  });

  it("rejects a precheck with a shell metacharacter (same guard as command)", () => {
    const yaml = `
operations:
  - name: nuc_pull
    risk: mutating
    command: [docker, pull, hello-world]
    precheck: [sh, -c, "rm -rf /"]
`;
    expect(() => parseOperations(yaml)).toThrow(/precheck has an unsafe argument/);
  });

  it("rejects an empty precheck array", () => {
    const yaml = `
operations:
  - name: nuc_pull
    risk: mutating
    command: [docker, pull, hello-world]
    precheck: []
`;
    expect(() => parseOperations(yaml)).toThrow(/precheck must be a non-empty array/);
  });
});
