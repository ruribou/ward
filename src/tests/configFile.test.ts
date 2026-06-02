import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { loadConfigFile, setConfigValue } from "../configFile.js";

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ward-configfile-test-"));
  path = join(dir, "config.yaml");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("loadConfigFile — tolerant read", () => {
  it("returns {} for a missing file (never throws)", () => {
    expect(loadConfigFile(join(dir, "absent.yaml"))).toEqual({});
  });

  it("returns {} for corrupt YAML (never throws)", () => {
    writeFileSync(path, "language: ja\n  : : broken\n");
    expect(loadConfigFile(path)).toEqual({});
  });

  it("returns {} for a non-object body", () => {
    writeFileSync(path, "just a string\n");
    expect(loadConfigFile(path)).toEqual({});
  });

  it("reads known string keys", () => {
    writeFileSync(path, "language: ja\nssh_host: nuc\n");
    expect(loadConfigFile(path)).toEqual({ language: "ja", ssh_host: "nuc" });
  });

  it("ignores unknown keys and non-string values", () => {
    writeFileSync(path, "language: ja\nssh_host: 123\nautonomy: approval\nextra: x\n");
    expect(loadConfigFile(path)).toEqual({ language: "ja" });
  });
});

describe("setConfigValue — validated, atomic, key-preserving write", () => {
  it("round-trips a value through loadConfigFile", () => {
    setConfigValue(path, "language", "ja");
    expect(loadConfigFile(path)).toEqual({ language: "ja" });
  });

  it("preserves the untouched key when setting the other", () => {
    setConfigValue(path, "language", "ja");
    setConfigValue(path, "ssh_host", "nuc");
    expect(loadConfigFile(path)).toEqual({ language: "ja", ssh_host: "nuc" });
  });

  it("creates the parent directory if missing", () => {
    const nested = join(dir, "a", "b", "config.yaml");
    setConfigValue(nested, "ssh_host", "nuc");
    expect(existsSync(nested)).toBe(true);
    expect(loadConfigFile(nested)).toEqual({ ssh_host: "nuc" });
  });

  it("writes valid YAML (no leftover temp file)", () => {
    setConfigValue(path, "language", "en");
    expect(parse(readFileSync(path, "utf8"))).toMatchObject({ language: "en" });
    expect(existsSync(`${path}.tmp`)).toBe(false);
  });

  it("rejects an unknown key", () => {
    expect(() => setConfigValue(path, "autonomy", "approval")).toThrow(/not a settable/);
    expect(existsSync(path)).toBe(false);
  });

  it("rejects an invalid language", () => {
    expect(() => setConfigValue(path, "language", "fr")).toThrow(/invalid language/);
  });

  it("rejects an empty ssh_host", () => {
    expect(() => setConfigValue(path, "ssh_host", "")).toThrow(/invalid ssh_host/);
  });

  it("rejects an ssh_host that looks like a real address (spaces/colons/slashes)", () => {
    expect(() => setConfigValue(path, "ssh_host", "nuc:22")).toThrow(/invalid ssh_host/);
    expect(() => setConfigValue(path, "ssh_host", "user@nuc")).toThrow(/invalid ssh_host/);
    expect(() => setConfigValue(path, "ssh_host", "host name")).toThrow(/invalid ssh_host/);
  });

  it("accepts an alias matching the charset", () => {
    setConfigValue(path, "ssh_host", "ward-host_2.lab");
    expect(loadConfigFile(path)).toEqual({ ssh_host: "ward-host_2.lab" });
  });
});
