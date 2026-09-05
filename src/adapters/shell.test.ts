import { describe, expect, it, vi, beforeEach } from "vitest";

const runCommandMock = vi.fn();
vi.mock("./exec.js", () => ({ runCommand: runCommandMock }));

const { delegateFreeAdapter, delegateCheapAdapter, codexAdapter, claudeAdapter } = await import("./shell.js");

describe("shell adapters", () => {
  beforeEach(() => {
    runCommandMock.mockReset();
    runCommandMock.mockResolvedValue({ status: "ok", output: "done", exitCode: 0 });
  });

  it("delegateFreeAdapter shells to `delegate free <task>`", async () => {
    await delegateFreeAdapter.run("reformat this file", { timeoutMs: 5000 });
    expect(runCommandMock).toHaveBeenCalledWith("delegate", ["free", "reformat this file"], 5000);
  });

  it("delegateCheapAdapter shells to `delegate cheap <task>`", async () => {
    await delegateCheapAdapter.run("summarize this article", { timeoutMs: 5000 });
    expect(runCommandMock).toHaveBeenCalledWith("delegate", ["cheap", "summarize this article"], 5000);
  });

  it("codexAdapter shells to `delegate gpt <task>`", async () => {
    await codexAdapter.run("implement this function", { timeoutMs: 5000 });
    expect(runCommandMock).toHaveBeenCalledWith("delegate", ["gpt", "implement this function"], 5000);
  });

  it("claudeAdapter shells to `claude -p <task>`", async () => {
    await claudeAdapter.run("review this diff", { timeoutMs: 5000 });
    expect(runCommandMock).toHaveBeenCalledWith("claude", ["-p", "review this diff"], 5000);
  });

  it("every adapter's name field matches its ProviderName", () => {
    expect(delegateFreeAdapter.name).toBe("delegate-free");
    expect(delegateCheapAdapter.name).toBe("delegate-cheap");
    expect(codexAdapter.name).toBe("codex");
    expect(claudeAdapter.name).toBe("claude");
  });
});
