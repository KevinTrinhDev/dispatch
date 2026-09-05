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

  it("returns a not-implemented error for tier 1 without ever calling runCommand", async () => {
    const adapter = createGazeAdapter(1);
    const result = await adapter.run("look up this order status", { timeoutMs: 5000 });
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.message).toMatch(/not yet implemented/i);
    }
    expect(runCommandMock).not.toHaveBeenCalled();
  });

  it("returns a not-implemented error for tier 2 without ever calling runCommand", async () => {
    const adapter = createGazeAdapter(2);
    const result = await adapter.run("look up public docs", { timeoutMs: 5000 });
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.message).toMatch(/not yet implemented/i);
    }
    expect(runCommandMock).not.toHaveBeenCalled();
  });

  it("adapter name is always gaze regardless of tier", () => {
    expect(createGazeAdapter(1).name).toBe("gaze");
    expect(createGazeAdapter(2).name).toBe("gaze");
  });
});
