import { afterEach, describe, expect, it, vi } from "vitest";

// config reads env at import time, so each case re-imports it with a fresh module
// registry after setting the env it should observe.
async function freshConfig(env: { WARD_AUTONOMY?: string; WARD_LANG?: string } = {}) {
  delete process.env.WARD_AUTONOMY;
  delete process.env.WARD_LANG;
  if (env.WARD_AUTONOMY !== undefined) process.env.WARD_AUTONOMY = env.WARD_AUTONOMY;
  if (env.WARD_LANG !== undefined) process.env.WARD_LANG = env.WARD_LANG;
  vi.resetModules();
  return (await import("../config.js")).config;
}

afterEach(() => {
  delete process.env.WARD_AUTONOMY;
  delete process.env.WARD_LANG;
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

describe("config.lang", () => {
  it("defaults to en when WARD_LANG is unset", async () => {
    expect((await freshConfig()).lang).toBe("en");
  });

  it("reads 'ja' from WARD_LANG", async () => {
    expect((await freshConfig({ WARD_LANG: "ja" })).lang).toBe("ja");
  });

  it("falls back to en for an unrecognized value", async () => {
    expect((await freshConfig({ WARD_LANG: "fr" })).lang).toBe("en");
  });
});
