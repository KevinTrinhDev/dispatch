import { describe, expect, it } from "vitest";
import { eligibleProviders } from "./rules.js";

describe("eligibleProviders", () => {
  it("tier 0 only allows delegate-free", () => {
    expect(eligibleProviders(0)).toEqual(["delegate-free"]);
  });

  it("tier 0 never includes gaze, even structurally", () => {
    expect(eligibleProviders(0)).not.toContain("gaze");
  });

  it("tier 1 includes delegate-free, claude, codex, and gaze but not delegate-cheap", () => {
    const providers = eligibleProviders(1);
    expect(providers).toContain("delegate-free");
    expect(providers).toContain("claude");
    expect(providers).toContain("codex");
    expect(providers).toContain("gaze");
    expect(providers).not.toContain("delegate-cheap");
  });

  it("tier 2 includes all five providers", () => {
    const providers = eligibleProviders(2);
    expect(providers).toEqual(
      expect.arrayContaining(["delegate-free", "claude", "codex", "delegate-cheap", "gaze"])
    );
    expect(providers.length).toBe(5);
  });

  it("delegate-free is always first in every tier's order (cheapest first)", () => {
    expect(eligibleProviders(0)[0]).toBe("delegate-free");
    expect(eligibleProviders(1)[0]).toBe("delegate-free");
    expect(eligibleProviders(2)[0]).toBe("delegate-free");
  });
});
