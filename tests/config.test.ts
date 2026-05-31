import { afterEach, describe, expect, it, vi } from "vitest";

// config reads env at import time, so each case re-imports it with a fresh module
// registry after setting the env it should observe.
async function freshConfig(autonomy: string | undefined) {
  if (autonomy === undefined) {
    delete process.env.WARD_AUTONOMY;
  } else {
    process.env.WARD_AUTONOMY = autonomy;
  }
  vi.resetModules();
  return (await import("../src/config.js")).config;
}

afterEach(() => {
  delete process.env.WARD_AUTONOMY;
  vi.resetModules();
});

describe("config.autonomy", () => {
  it("defaults to read-only when WARD_AUTONOMY is unset", async () => {
    expect((await freshConfig(undefined)).autonomy).toBe("read-only");
  });

  it("reads 'approval' from WARD_AUTONOMY", async () => {
    expect((await freshConfig("approval")).autonomy).toBe("approval");
  });

  it("falls back to the read-only floor for an unrecognized value", async () => {
    expect((await freshConfig("yolo")).autonomy).toBe("read-only");
  });
});
