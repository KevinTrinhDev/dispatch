import { describe, expect, it, vi, beforeEach } from "vitest";

const execaMock = vi.fn();
vi.mock("execa", () => ({ execa: execaMock }));

const { runCommand } = await import("./exec.js");

describe("runCommand", () => {
  beforeEach(() => {
    execaMock.mockReset();
  });

  it("returns ok on a clean exit", async () => {
    execaMock.mockResolvedValue({ stdout: "hello", exitCode: 0, timedOut: false });
    const result = await runCommand("echo", ["hello"], 5000);
    expect(result).toEqual({ status: "ok", output: "hello", exitCode: 0 });
  });

  it("returns timeout when execa reports timedOut", async () => {
    execaMock.mockResolvedValue({ stdout: "", exitCode: null, timedOut: true });
    const result = await runCommand("sleep", ["999"], 100);
    expect(result).toEqual({ status: "timeout" });
  });

  it("returns partial when exit code is non-zero", async () => {
    execaMock.mockResolvedValue({ stdout: "partial output", exitCode: 1, timedOut: false });
    const result = await runCommand("false-ish", [], 5000);
    expect(result).toEqual({ status: "partial", output: "partial output", reason: "exited with code 1" });
  });

  it("returns error when execa throws", async () => {
    execaMock.mockRejectedValue(new Error("ENOENT: command not found"));
    const result = await runCommand("nonexistent", [], 5000);
    expect(result).toEqual({ status: "error", message: "ENOENT: command not found" });
  });

  it("passes command and args to execa as an argv array, never a shell string", async () => {
    execaMock.mockResolvedValue({ stdout: "ok", exitCode: 0, timedOut: false });
    await runCommand("claude", ["-p", "some task; rm -rf /"], 5000);
    expect(execaMock).toHaveBeenCalledWith(
      "claude",
      ["-p", "some task; rm -rf /"],
      expect.objectContaining({ timeout: 5000, reject: false })
    );
  });
});
