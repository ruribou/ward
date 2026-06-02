import { describe, expect, it } from "vitest";
import { LOCALES } from "../../config.js";
import { getLabel } from "../../i18n/index.js";
import {
  OperationLoadError,
  ParamResolutionError,
  operations,
  parseOperations,
  resolveOperation,
} from "../../registry/operations.js";

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
    expect(mutating).toContain("sys_pull_image");
    expect(mutating).toContain("sys_remove_image");
  });

  it("uses the sys_ tool-name convention", () => {
    for (const op of operations) {
      expect(op.name).toMatch(/^sys_[a-z]+(_[a-z]+)*$/);
    }
  });

  it("has commands of constants or {param} placeholders only (no shell metacharacters)", () => {
    for (const op of operations) {
      expect(op.command.length).toBeGreaterThan(0);
      for (const part of op.command) {
        expect(part).toMatch(/^[A-Za-z0-9_.-]+$|^\{[a-z][a-z0-9_]*\}$/);
      }
    }
  });

  it("resolves every parameterized op to a concrete, placeholder-free command", () => {
    for (const op of operations.filter((o) => o.params !== undefined)) {
      const args = Object.fromEntries((op.params ?? []).map((p) => [p.name, p.allow[0]!]));
      const resolved = resolveOperation(op, args);
      for (const part of [...resolved.command, ...(resolved.precheck ?? [])]) {
        // The broad backstop charset: a typed param (port/url) may substitute `:`/`/`,
        // but never a space or shell metacharacter — the executor asserts the same.
        expect(part).toMatch(/^[A-Za-z0-9_.:/%-]+$/);
      }
      expect(resolved.params).toBeUndefined();
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

  it("declares a reversibility stance on every mutating op, and none on read-only ops", () => {
    for (const op of operations) {
      if (op.risk === "mutating") {
        const declared = (op.inverse !== undefined ? 1 : 0) + (op.irreversible === true ? 1 : 0);
        expect(declared).toBe(1); // exactly one of inverse / irreversible
      } else {
        expect(op.inverse).toBeUndefined();
        expect(op.irreversible).toBeUndefined();
      }
    }
  });

  it("makes sys_pull_image and sys_remove_image mutual inverses (the first inverse pair)", () => {
    const pull = operations.find((o) => o.name === "sys_pull_image");
    const remove = operations.find((o) => o.name === "sys_remove_image");
    expect(pull?.inverse).toBe("sys_remove_image");
    expect(remove?.inverse).toBe("sys_pull_image");
  });

  it("publishes sys_run_container to a fixed host port via a typed port param (#49)", () => {
    const run = operations.find((o) => o.name === "sys_run_container");
    expect(run?.command).toContain("-p"); // a fixed mapping, not -P (random)
    expect(run?.command).not.toContain("-P");
    const publish = run?.params?.find((p) => p.name === "publish");
    expect(publish?.type).toBe("port");
    for (const member of publish?.allow ?? []) {
      expect(member).toMatch(/^[0-9]+:[0-9]+$/); // every allowed mapping is host:container
    }
  });

  it("adds sys_http_check as a read-only, allowlisted-localhost-URL probe (#49)", () => {
    const check = operations.find((o) => o.name === "sys_http_check");
    expect(check?.risk).toBe("read-only");
    expect(check?.command[0]).toBe("curl");
    const url = check?.params?.find((p) => p.name === "url");
    expect(url?.type).toBe("url");
    for (const member of url?.allow ?? []) {
      expect(member).toMatch(/^https?:\/\/(localhost|127\.0\.0\.1)(:[0-9]+)?\//);
    }
  });
});

describe("parseOperations (the loader guardrail)", () => {
  const valid = `
operations:
  - name: sys_uptime
    risk: read-only
    command: [uptime]
`;

  it("loads a well-formed registry", () => {
    const ops = parseOperations(valid);
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ name: "sys_uptime", command: ["uptime"] });
  });

  it("rejects a command argument with a shell metacharacter", () => {
    const yaml = `
operations:
  - name: sys_pwn
    risk: read-only
    command: [sh, -c, "rm -rf /"]
`;
    expect(() => parseOperations(yaml)).toThrow(OperationLoadError);
  });

  it("rejects a path argument (slash is not in the safe charset)", () => {
    const yaml = `
operations:
  - name: sys_cat
    risk: read-only
    command: [cat, /etc/shadow]
`;
    expect(() => parseOperations(yaml)).toThrow(/unsafe argument/);
  });

  it("rejects an unknown risk class", () => {
    const yaml = `
operations:
  - name: sys_uptime
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
  - { name: sys_uptime, risk: read-only, command: [uptime] }
  - { name: sys_uptime, risk: read-only, command: [uptime] }
`;
    expect(() => parseOperations(yaml)).toThrow(/duplicate/);
  });

  it("loads an optional precheck and validates it like command", () => {
    const yaml = `
operations:
  - name: sys_pull_image
    risk: mutating
    irreversible: true
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
  - name: sys_pull_image
    risk: mutating
    irreversible: true
    command: [docker, pull, hello-world]
    precheck: [sh, -c, "rm -rf /"]
`;
    expect(() => parseOperations(yaml)).toThrow(/precheck has an unsafe argument/);
  });

  it("rejects an empty precheck array", () => {
    const yaml = `
operations:
  - name: sys_pull_image
    risk: mutating
    irreversible: true
    command: [docker, pull, hello-world]
    precheck: []
`;
    expect(() => parseOperations(yaml)).toThrow(/precheck must be a non-empty array/);
  });
});

describe("parseOperations — parameterized operations (enum allowlist)", () => {
  const paramOp = (body: string) => `
operations:
  - name: sys_pull_image
    risk: mutating
    irreversible: true
    command: [docker, pull, "{image}"]
${body}
`;

  it("loads a valid parameterized op and keeps its declared enum", () => {
    const ops = parseOperations(
      paramOp(`    params:\n      - name: image\n        allow: [hello-world, alpine]`),
    );
    expect(ops[0]?.command).toEqual(["docker", "pull", "{image}"]);
    expect(ops[0]?.params).toEqual([{ name: "image", allow: ["hello-world", "alpine"] }]);
  });

  it("validates a placeholder used in precheck too", () => {
    const yaml = `
operations:
  - name: sys_remove_image
    risk: mutating
    irreversible: true
    command: [docker, rmi, "{image}"]
    precheck: [docker, images, "{image}"]
    params:
      - name: image
        allow: [alpine]
`;
    expect(parseOperations(yaml)[0]?.precheck).toEqual(["docker", "images", "{image}"]);
  });

  it("rejects an enum member that fails the charset guard", () => {
    expect(() =>
      parseOperations(paramOp(`    params:\n      - name: image\n        allow: ["alpine:3.20"]`)),
    ).toThrow(/allow has an unsafe value/);
  });

  it("rejects an empty enum", () => {
    expect(() =>
      parseOperations(paramOp(`    params:\n      - name: image\n        allow: []`)),
    ).toThrow(/allow must be a non-empty enum/);
  });

  it("rejects a placeholder with no matching param declaration", () => {
    expect(() =>
      parseOperations(paramOp(`    params:\n      - name: tag\n        allow: [latest]`)),
    ).toThrow(/uses placeholder \{image\} but declares no param "image"/);
  });

  it("rejects a declared param that is never referenced", () => {
    const yaml = `
operations:
  - name: sys_pull_image
    risk: mutating
    irreversible: true
    command: [docker, pull, hello-world]
    params:
      - name: image
        allow: [hello-world]
`;
    expect(() => parseOperations(yaml)).toThrow(/never uses \{image\}/);
  });

  it("rejects a duplicate param name", () => {
    const yaml = `
operations:
  - name: sys_pull_image
    risk: mutating
    irreversible: true
    command: [docker, pull, "{image}"]
    params:
      - name: image
        allow: [alpine]
      - name: image
        allow: [nginx]
`;
    expect(() => parseOperations(yaml)).toThrow(/duplicate parameter "image"/);
  });

  it("rejects an unsafe param name", () => {
    expect(() =>
      parseOperations(paramOp(`    params:\n      - name: Image\n        allow: [alpine]`)),
    ).toThrow(/params\[0\].name must match/);
  });
});

describe("parseOperations — per-param value types (#49: ':' '/' via a typed allowlist)", () => {
  // A read-only op (so no reversibility stance is needed) with one typed param.
  const typed = (type: string, allow: string) => `
operations:
  - name: sys_probe
    risk: read-only
    command: [echo, "{value}"]
    params:
      - name: value
        type: ${type}
        allow: ${allow}
`;
  // The same op WITHOUT a type — members are held to the strict token charset.
  const untyped = (allow: string) => `
operations:
  - name: sys_probe
    risk: read-only
    command: [echo, "{value}"]
    params:
      - name: value
        allow: ${allow}
`;

  it("loads a port-typed param whose members contain a colon", () => {
    const ops = parseOperations(typed("port", `["8080:80", "9090:90"]`));
    expect(ops[0]?.params?.[0]).toEqual({
      name: "value",
      type: "port",
      allow: ["8080:80", "9090:90"],
    });
  });

  it("loads a url-typed param restricted to the loopback host (with port and path)", () => {
    const ops = parseOperations(
      typed("url", `["http://localhost:8080/", "http://127.0.0.1/health"]`),
    );
    expect(ops[0]?.params?.[0]?.type).toBe("url");
    expect(ops[0]?.params?.[0]?.allow).toEqual([
      "http://localhost:8080/",
      "http://127.0.0.1/health",
    ]);
  });

  it("rejects an unknown param type (a new type is a vetted code change, not free-form YAML)", () => {
    expect(() => parseOperations(typed("regex", `["anything"]`))).toThrow(/is not a known type/);
  });

  it("STILL rejects a colon for an UNtyped param — the strict charset is not globally loosened", () => {
    // The whole point of #49: `:` is reachable only through a vetted type, never by
    // default. An untyped member with a colon must still fail to load.
    expect(() => parseOperations(untyped(`["8080:80"]`))).toThrow(/has an unsafe value/);
  });

  it("rejects a port member that is not host:container shaped", () => {
    expect(() => parseOperations(typed("port", `["8080"]`))).toThrow(/has an unsafe value/);
    expect(() => parseOperations(typed("port", `["80:80:80"]`))).toThrow(/has an unsafe value/);
    expect(() => parseOperations(typed("port", `["80:http"]`))).toThrow(/has an unsafe value/);
  });

  it("rejects a port member smuggling a shell metacharacter or space (injection guard)", () => {
    expect(() => parseOperations(typed("port", `["80;reboot:80"]`))).toThrow(/has an unsafe value/);
    expect(() => parseOperations(typed("port", `["80 80:80"]`))).toThrow(/has an unsafe value/);
    expect(() => parseOperations(typed("port", `["$(reboot):80"]`))).toThrow(/has an unsafe value/);
  });

  it("rejects a url member pointing off the loopback host", () => {
    expect(() => parseOperations(typed("url", `["http://evil.example.com/"]`))).toThrow(
      /has an unsafe value/,
    );
    expect(() => parseOperations(typed("url", `["http://localhost.evil.com/"]`))).toThrow(
      /has an unsafe value/,
    );
  });

  it("rejects a url member smuggling a shell metacharacter (injection guard)", () => {
    expect(() => parseOperations(typed("url", `["http://localhost/;reboot"]`))).toThrow(
      /has an unsafe value/,
    );
    expect(() => parseOperations(typed("url", `["http://localhost/$(reboot)"]`))).toThrow(
      /has an unsafe value/,
    );
    // a space splits one argv element into two on the remote command line
    expect(() => parseOperations(typed("url", `["http://localhost/ a"]`))).toThrow(
      /has an unsafe value/,
    );
  });

  it("resolveOperation substitutes a chosen port member (carrying its colon) into the command", () => {
    const op = parseOperations(typed("port", `["8080:80", "9090:90"]`))[0]!;
    expect(resolveOperation(op, { value: "9090:90" }).command).toEqual(["echo", "9090:90"]);
  });

  it("resolveOperation rejects a typed value outside the enum allowlist", () => {
    const op = parseOperations(typed("port", `["8080:80"]`))[0]!;
    expect(() => resolveOperation(op, { value: "9999:99" })).toThrow(/must be one of/);
  });
});

describe("parseOperations — reversibility (inverse / irreversible) validation", () => {
  const pair = `
operations:
  - name: sys_pull_image
    risk: mutating
    inverse: sys_remove_image
    command: [docker, pull, alpine]
  - name: sys_remove_image
    risk: mutating
    inverse: sys_pull_image
    command: [docker, rmi, alpine]
`;

  it("accepts a mutually-inverse mutating pair and keeps each inverse", () => {
    const ops = parseOperations(pair);
    expect(ops.find((o) => o.name === "sys_pull_image")?.inverse).toBe("sys_remove_image");
    expect(ops.find((o) => o.name === "sys_remove_image")?.inverse).toBe("sys_pull_image");
  });

  it("accepts a mutating op marked irreversible", () => {
    const ops = parseOperations(`
operations:
  - name: sys_reboot
    risk: mutating
    irreversible: true
    command: [sudo, reboot]
`);
    expect(ops[0]?.irreversible).toBe(true);
    expect(ops[0]?.inverse).toBeUndefined();
  });

  it("rejects a mutating op that declares NEITHER inverse nor irreversible", () => {
    const yaml = `
operations:
  - name: sys_reboot
    risk: mutating
    command: [sudo, reboot]
`;
    expect(() => parseOperations(yaml)).toThrow(
      /must declare exactly one of inverse \/ irreversible \(declares neither\)/,
    );
  });

  it("rejects a mutating op that declares BOTH inverse and irreversible", () => {
    const yaml = `
operations:
  - name: sys_pull_image
    risk: mutating
    irreversible: true
    inverse: sys_remove_image
    command: [docker, pull, alpine]
  - name: sys_remove_image
    risk: mutating
    inverse: sys_pull_image
    command: [docker, rmi, alpine]
`;
    expect(() => parseOperations(yaml)).toThrow(/declares both/);
  });

  it("rejects an inverse that names no operation in the registry (dangling)", () => {
    const yaml = `
operations:
  - name: sys_pull_image
    risk: mutating
    inverse: sys_does_not_exist
    command: [docker, pull, alpine]
`;
    expect(() => parseOperations(yaml)).toThrow(/names no operation in the registry/);
  });

  it("rejects an inverse that points at a read-only operation", () => {
    const yaml = `
operations:
  - name: sys_pull_image
    risk: mutating
    inverse: sys_images
    command: [docker, pull, alpine]
  - name: sys_images
    risk: read-only
    command: [docker, images]
`;
    expect(() => parseOperations(yaml)).toThrow(
      /is read-only — an inverse must itself be mutating/,
    );
  });

  it("rejects a read-only op that declares an inverse", () => {
    const yaml = `
operations:
  - name: sys_images
    risk: read-only
    inverse: sys_remove_image
    command: [docker, images]
  - name: sys_remove_image
    risk: mutating
    irreversible: true
    command: [docker, rmi, alpine]
`;
    expect(() => parseOperations(yaml)).toThrow(
      /read-only and must declare neither inverse nor irreversible/,
    );
  });

  it("rejects a read-only op that declares irreversible", () => {
    const yaml = `
operations:
  - name: sys_disk
    risk: read-only
    irreversible: true
    command: [df, -h]
`;
    expect(() => parseOperations(yaml)).toThrow(
      /read-only and must declare neither inverse nor irreversible/,
    );
  });

  it("rejects an irreversible value that is not the literal true", () => {
    const yaml = `
operations:
  - name: sys_reboot
    risk: mutating
    irreversible: yes-please
    command: [sudo, reboot]
`;
    expect(() => parseOperations(yaml)).toThrow(/irreversible, if set, must be the literal true/);
  });
});

describe("resolveOperation — enforces the enum and substitutes (no placeholder survives)", () => {
  const op = parseOperations(`
operations:
  - name: sys_pull_image
    risk: mutating
    irreversible: true
    command: [docker, pull, "{image}"]
    precheck: [docker, images, "{image}"]
    params:
      - name: image
        allow: [hello-world, alpine]
`)[0]!;

  it("substitutes a chosen enum member into command and precheck", () => {
    const resolved = resolveOperation(op, { image: "alpine" });
    expect(resolved.command).toEqual(["docker", "pull", "alpine"]);
    expect(resolved.precheck).toEqual(["docker", "images", "alpine"]);
    expect(resolved.params).toBeUndefined(); // a resolved op carries no params
  });

  it("preserves reversibility on the resolved op so a proposal can surface it", () => {
    const reversible = parseOperations(`
operations:
  - name: sys_pull_image
    risk: mutating
    inverse: sys_remove_image
    command: [docker, pull, "{image}"]
    params:
      - name: image
        allow: [alpine]
  - name: sys_remove_image
    risk: mutating
    inverse: sys_pull_image
    command: [docker, rmi, "{image}"]
    params:
      - name: image
        allow: [alpine]
`)[0]!;
    const resolved = resolveOperation(reversible, { image: "alpine" });
    expect(resolved.inverse).toBe("sys_remove_image");
    expect(resolved.irreversible).toBeUndefined();
  });

  it("rejects a value outside the enum allowlist", () => {
    expect(() => resolveOperation(op, { image: "ubuntu" })).toThrow(ParamResolutionError);
    expect(() => resolveOperation(op, { image: "ubuntu" })).toThrow(/must be one of/);
  });

  it("rejects a missing required parameter", () => {
    expect(() => resolveOperation(op, {})).toThrow(/requires parameter "image"/);
  });

  it("rejects an unexpected parameter key", () => {
    expect(() => resolveOperation(op, { image: "alpine", tag: "latest" })).toThrow(
      /has no parameter "tag"/,
    );
  });

  it("returns a no-param op unchanged when given no arguments", () => {
    const plain = parseOperations(`
operations:
  - name: sys_uptime
    risk: read-only
    command: [uptime]
`)[0]!;
    expect(resolveOperation(plain)).toEqual(plain);
  });
});
