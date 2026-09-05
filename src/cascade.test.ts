import { describe, expect, it, vi } from "vitest";
import { runCascade, type AdapterRegistry } from "./cascade.js";
import type { ProviderAdapter } from "./types.js";

function fakeAdapter(name: ProviderAdapter["name"], run: ProviderAdapter["run"]): ProviderAdapter {
  return { name, run };
}

describe("runCascade", () => {
  it("returns verified output from the first provider when it succeeds", async () => {
    const free = fakeAdapter("delegate-free", async () => ({ status: "ok", output: "good answer", exitCode: 0 }));
    const adapters: AdapterRegistry = { "delegate-free": free };

    const outcome = await runCascade("do a thing", 0, adapters);

    expect(outcome.finalStatus).toBe("verified");
    expect(outcome.finalProvider).toBe("delegate-free");
    expect(outcome.finalOutput).toBe("good answer");
    expect(outcome.attempts).toHaveLength(1);
  });

  it("escalates to the next provider when the first fails verification", async () => {
    const free = fakeAdapter("delegate-free", async () => ({ status: "ok", output: "", exitCode: 0 }));
    const claude = fakeAdapter("claude", async () => ({ status: "ok", output: "real answer", exitCode: 0 }));
    const adapters: AdapterRegistry = { "delegate-free": free, claude };

    const outcome = await runCascade("do a thing", 1, adapters);

    expect(outcome.finalStatus).toBe("verified");
    expect(outcome.finalProvider).toBe("claude");
    expect(outcome.attempts.map((a) => a.provider)).toEqual(["delegate-free", "claude"]);
  });

  it("escalates past a timeout or error result", async () => {
    const free = fakeAdapter("delegate-free", async () => ({ status: "timeout" }));
    const claude = fakeAdapter("claude", async () => ({ status: "ok", output: "answer", exitCode: 0 }));
    const adapters: AdapterRegistry = { "delegate-free": free, claude };

    const outcome = await runCascade("do a thing", 1, adapters);

    expect(outcome.finalProvider).toBe("claude");
  });

  it("escalates past an error result", async () => {
    const free = fakeAdapter("delegate-free", async () => ({ status: "error", message: "boom" }));
    const claude = fakeAdapter("claude", async () => ({ status: "ok", output: "answer", exitCode: 0 }));
    const adapters: AdapterRegistry = { "delegate-free": free, claude };

    const outcome = await runCascade("do a thing", 1, adapters);

    expect(outcome.finalStatus).toBe("verified");
    expect(outcome.finalProvider).toBe("claude");
    expect(outcome.finalOutput).toBe("answer");
  });

  it("escalates past a partial result", async () => {
    const free = fakeAdapter("delegate-free", async () => ({ status: "partial", output: "half", reason: "cut off" }));
    const claude = fakeAdapter("claude", async () => ({ status: "ok", output: "answer", exitCode: 0 }));
    const adapters: AdapterRegistry = { "delegate-free": free, claude };

    const outcome = await runCascade("do a thing", 1, adapters);

    expect(outcome.finalStatus).toBe("verified");
    expect(outcome.finalProvider).toBe("claude");
    expect(outcome.finalOutput).toBe("answer");
  });

  it("returns unverified with the last output when nothing in the cascade verifies", async () => {
    const free = fakeAdapter("delegate-free", async () => ({
      status: "ok",
      output: "I cannot help with that",
      exitCode: 0,
    }));
    const adapters: AdapterRegistry = { "delegate-free": free };

    const outcome = await runCascade("do a thing", 0, adapters);

    expect(outcome.finalStatus).toBe("unverified");
    expect(outcome.finalProvider).toBe("delegate-free");
  });

  it("returns all-failed when every adapter throws or errors", async () => {
    const free = fakeAdapter("delegate-free", async () => ({ status: "error", message: "boom" }));
    const adapters: AdapterRegistry = { "delegate-free": free };

    const outcome = await runCascade("do a thing", 0, adapters);

    expect(outcome.finalStatus).toBe("all-failed");
    expect(outcome.finalProvider).toBeNull();
  });

  it("does not treat a partial result with empty output as usable, and reports all-failed", async () => {
    const free = fakeAdapter("delegate-free", async () => ({ status: "partial", output: "   ", reason: "cut off" }));
    const adapters: AdapterRegistry = { "delegate-free": free };

    const outcome = await runCascade("do a thing", 0, adapters);

    expect(outcome.finalStatus).toBe("all-failed");
    expect(outcome.finalProvider).toBeNull();
    expect(outcome.finalOutput).toBe("");
  });

  it("never invokes gaze for tier 0, even if gaze is registered in the adapter map", async () => {
    const gazeRun = vi.fn(async () => ({ status: "ok" as const, output: "should never run", exitCode: 0 }));
    const free = fakeAdapter("delegate-free", async () => ({ status: "ok", output: "fine", exitCode: 0 }));
    const adapters: AdapterRegistry = { "delegate-free": free, gaze: fakeAdapter("gaze", gazeRun) };

    await runCascade("do a thing", 0, adapters);

    expect(gazeRun).not.toHaveBeenCalled();
  });

  it("escalates when a custom verifier rejects an otherwise-ok output", async () => {
    const free = fakeAdapter("delegate-free", async () => ({ status: "ok", output: "not json", exitCode: 0 }));
    const claude = fakeAdapter("claude", async () => ({ status: "ok", output: '["json"]', exitCode: 0 }));
    const adapters: AdapterRegistry = { "delegate-free": free, claude };
    const { verifyJsonOutput } = await import("./verify.js");

    const outcome = await runCascade("do a thing", 1, adapters, 120_000, verifyJsonOutput);

    expect(outcome.finalStatus).toBe("verified");
    expect(outcome.finalProvider).toBe("claude");
    expect(outcome.attempts.map((a) => a.provider)).toEqual(["delegate-free", "claude"]);
  });
});
