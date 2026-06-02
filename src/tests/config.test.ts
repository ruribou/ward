import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// config reads env (and the config file) at import time, so each case re-imports
// it with a fresh module registry after setting the env it should observe.
type Env = {
  WARD_AUTONOMY?: string;
  WARD_LANG?: string;
  WARD_SSH_HOST?: string;
  WARD_CONFIG_FILE?: string;
};

const tmpFiles: string[] = [];

/** Write a temp config.yaml and return its path; tracked for cleanup. */
function tmpConfig(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "ward-config-test-"));
  const path = join(dir, "config.yaml");
  writeFileSync(path, body);
  tmpFiles.push(dir);
  return path;
}

async function freshConfig(env: Env = {}) {
  delete process.env.WARD_AUTONOMY;
  delete process.env.WARD_LANG;
  delete process.env.WARD_SSH_HOST;
  delete process.env.WARD_CONFIG_FILE;
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) process.env[key] = value;
  }
  vi.resetModules();
  return (await import("../config.js")).config;
}

afterEach(() => {
  delete process.env.WARD_AUTONOMY;
  delete process.env.WARD_LANG;
  delete process.env.WARD_SSH_HOST;
  delete process.env.WARD_CONFIG_FILE;
  for (const dir of tmpFiles.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.resetModules();
});

describe("config.autonomy", () => {
  it("defaults to read-only when WARD_AUTONOMY is unset", async () => {
    expect((await freshConfig()).autonomy).toBe("read-only");
  });

  it("reads 'approval' from WARD_AUTONOMY", async () => {
    expect((await freshConfig({ WARD_AUTONOMY: "approval" })).autonomy).toBe("approval");
  });

  it("falls back to the read-only floor for an unrecognized value", async () => {
    expect((await freshConfig({ WARD_AUTONOMY: "yolo" })).autonomy).toBe("read-only");
  });
});

describe("config.lang — env > file > default", () => {
  it("defaults to en when nothing is set", async () => {
    expect((await freshConfig()).lang).toBe("en");
  });

  it("reads 'ja' from WARD_LANG", async () => {
    expect((await freshConfig({ WARD_LANG: "ja" })).lang).toBe("ja");
  });

  it("falls back to en for an unrecognized env value", async () => {
    expect((await freshConfig({ WARD_LANG: "fr" })).lang).toBe("en");
  });

  it("reads language from the config file when env is unset (file > default)", async () => {
    const WARD_CONFIG_FILE = tmpConfig("language: ja\n");
    expect((await freshConfig({ WARD_CONFIG_FILE })).lang).toBe("ja");
  });

  it("env overrides the file (env > file)", async () => {
    const WARD_CONFIG_FILE = tmpConfig("language: ja\n");
    expect((await freshConfig({ WARD_CONFIG_FILE, WARD_LANG: "en" })).lang).toBe("en");
  });

  it("falls back to en for an unrecognized file value", async () => {
    const WARD_CONFIG_FILE = tmpConfig("language: fr\n");
    expect((await freshConfig({ WARD_CONFIG_FILE })).lang).toBe("en");
  });

  it("defaults to en when the config file is missing", async () => {
    const WARD_CONFIG_FILE = join(tmpdir(), "ward-config-does-not-exist.yaml");
    expect((await freshConfig({ WARD_CONFIG_FILE })).lang).toBe("en");
  });

  it("defaults to en when the config file is corrupt YAML", async () => {
    const WARD_CONFIG_FILE = tmpConfig("language: ja\n  : : broken\n");
    expect((await freshConfig({ WARD_CONFIG_FILE })).lang).toBe("en");
  });
});

describe("config.sshHost — env > file > default", () => {
  it("defaults to ward-host when nothing is set", async () => {
    expect((await freshConfig()).sshHost).toBe("ward-host");
  });

  it("reads the alias from WARD_SSH_HOST", async () => {
    expect((await freshConfig({ WARD_SSH_HOST: "nuc" })).sshHost).toBe("nuc");
  });

  it("reads ssh_host from the config file when env is unset (file > default)", async () => {
    const WARD_CONFIG_FILE = tmpConfig("ssh_host: nuc\n");
    expect((await freshConfig({ WARD_CONFIG_FILE })).sshHost).toBe("nuc");
  });

  it("env overrides the file (env > file)", async () => {
    const WARD_CONFIG_FILE = tmpConfig("ssh_host: nuc\n");
    expect((await freshConfig({ WARD_CONFIG_FILE, WARD_SSH_HOST: "lab" })).sshHost).toBe("lab");
  });

  it("falls back to ward-host for an empty file value", async () => {
    const WARD_CONFIG_FILE = tmpConfig('ssh_host: ""\n');
    expect((await freshConfig({ WARD_CONFIG_FILE })).sshHost).toBe("ward-host");
  });

  it("ignores a non-string file value, falling back to ward-host", async () => {
    const WARD_CONFIG_FILE = tmpConfig("ssh_host: 123\n");
    expect((await freshConfig({ WARD_CONFIG_FILE })).sshHost).toBe("ward-host");
  });

  it("reads both language and ssh_host from one file", async () => {
    const WARD_CONFIG_FILE = tmpConfig("language: ja\nssh_host: nuc\n");
    const cfg = await freshConfig({ WARD_CONFIG_FILE });
    expect(cfg.lang).toBe("ja");
    expect(cfg.sshHost).toBe("nuc");
  });
});
