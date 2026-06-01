import { afterEach, describe, expect, it } from "vitest";
import { _resetLabelCache, getLabel, getLabelOr } from "../i18n/index.js";

afterEach(() => {
  _resetLabelCache();
});

describe("i18n label loader", () => {
  it("resolves a dot-path key for the default locale (en)", () => {
    expect(getLabel("ops.nuc_uptime.title")).toBe("Uptime");
  });

  it("resolves the same key in another locale", () => {
    expect(getLabel("ops.nuc_uptime.title", "ja")).toBe("稼働状況");
  });

  it("substitutes {var} placeholders", () => {
    const text = getLabel("cli.notFound", "en", { id: "p7" });
    expect(text).toContain("p7");
    expect(text).not.toContain("{id}");
  });

  it("leaves an unmatched placeholder untouched", () => {
    expect(getLabel("cli.notFound", "en", {})).toContain("{id}");
  });

  it("throws for a missing key", () => {
    expect(() => getLabel("ops.does_not_exist.title")).toThrow(/missing label/);
  });

  it("throws when a key resolves to a group rather than a string leaf", () => {
    expect(() => getLabel("ops")).toThrow(/missing label/);
  });

  it("getLabelOr falls back when the key is absent", () => {
    expect(getLabelOr("ops.nope.title", "fallback")).toBe("fallback");
  });

  it("getLabelOr returns the label when present", () => {
    expect(getLabelOr("ops.nuc_uptime.title", "fallback")).toBe("Uptime");
  });

  it("caches a locale across calls and reloads after a reset", () => {
    expect(getLabel("ops.nuc_disk.title")).toBe("Disk usage");
    expect(getLabel("ops.nuc_disk.title")).toBe("Disk usage"); // cache hit
    _resetLabelCache();
    expect(getLabel("ops.nuc_disk.title")).toBe("Disk usage"); // reload
  });
});
