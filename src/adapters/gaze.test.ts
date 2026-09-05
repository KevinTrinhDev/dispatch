import { describe, expect, it, vi, beforeEach } from "vitest";

const runCommandMock = vi.fn();
vi.mock("./exec.js", () => ({ runCommand: runCommandMock }));

const { createGazeAdapter, GazeTierBlockedError } = await import("./gaze.js");

describe("gaze adapter", () => {
  beforeEach(() => {
    runCommandMock.mockReset();
    runCommandMock.mockResolvedValue({ status: "ok", output: "done", exitCode: 0 });
  });

  it("rejects with GazeTierBlockedError for tier 0 without ever calling runCommand", async () => {
    const adapter = createGazeAdapter(0);
    await expect(adapter.run("check my email", { timeoutMs: 5000 })).rejects.toThrow(GazeTierBlockedError);
    expect(runCommandMock).not.toHaveBeenCalled();
  });

  it("calls runCommand for tier 1", async () => {
    const adapter = createGazeAdapter(1);
    await adapter.run("look up this order status", { timeoutMs: 5000 });
    expect(runCommandMock).toHaveBeenCalledWith("gaze", ["prompt", "look up this order status"], 5000);
  });

  it("calls runCommand for tier 2", async () => {
    const adapter = createGazeAdapter(2);
    await adapter.run("look up public docs", { timeoutMs: 5000 });
    expect(runCommandMock).toHaveBeenCalledWith("gaze", ["prompt", "look up public docs"], 5000);
  });

  it("never passes an auto-approve or bypass flag to gaze", async () => {
    const adapter = createGazeAdapter(2);
    await adapter.run("do something", { timeoutMs: 5000 });
    const [, args] = runCommandMock.mock.calls[0];
    for (const arg of args as string[]) {
      expect(arg.toLowerCase()).not.toMatch(/--yes|--approve|--auto-approve|--grant/);
    }
  });

  it("adapter name is always gaze regardless of tier", () => {
    expect(createGazeAdapter(1).name).toBe("gaze");
    expect(createGazeAdapter(2).name).toBe("gaze");
  });
});
