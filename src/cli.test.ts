import { describe, expect, it, vi } from "vitest";
import { readFile, rm, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "./cli.js";
import type { AdapterRegistry } from "./cascade.js";
import type { ProviderAdapter } from "./types.js";

function fakeAdapter(name: ProviderAdapter["name"], output: string): ProviderAdapter {
  return {
    name,
    run: vi.fn(async () => ({ status: "ok" as const, output, exitCode: 0 })),
  };
}

async function withTempAuditPath(fn: (path: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "dispatch-cli-"));
  const path = join(dir, "audit.jsonl");
  try {
    await fn(path);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("main", () => {
  it("returns 1 and writes usage to stderr when --tier is missing", async () => {
    const stderrLines: string[] = [];
    const code = await main(["run", "do a thing"], () => {}, (s) => stderrLines.push(s));
    expect(code).toBe(1);
    expect(stderrLines.join("")).toContain("--tier");
  });

  it("runs the cascade and prints the final output on success", async () => {
    await withTempAuditPath(async (auditLogPath) => {
      const adapters: AdapterRegistry = { "delegate-free": fakeAdapter("delegate-free", "the answer") };
      const stdoutLines: string[] = [];

      const code = await main(
        ["run", "--tier", "0", "do a thing"],
        (s) => stdoutLines.push(s),
        () => {},
        { adapters, auditLogPath }
      );

      expect(code).toBe(0);
      expect(stdoutLines.join("")).toContain("the answer");
    });
  });

  it("writes a redacted audit record for a tier 0 run", async () => {
    await withTempAuditPath(async (auditLogPath) => {
      const adapters: AdapterRegistry = { "delegate-free": fakeAdapter("delegate-free", "the answer") };

      await main(["run", "--tier", "0", "a very secret task description here"], () => {}, () => {}, {
        adapters,
        auditLogPath,
      });

      const content = await readFile(auditLogPath, "utf-8");
      const record = JSON.parse(content.trim());
      expect(record.taskPreview.length).toBeLessThanOrEqual(40);
      expect(record.tier).toBe(0);
    });
  });

  it("prints a routing trace when --explain is passed", async () => {
    await withTempAuditPath(async (auditLogPath) => {
      const adapters: AdapterRegistry = { "delegate-free": fakeAdapter("delegate-free", "the answer") };
      const stdoutLines: string[] = [];

      await main(["run", "--tier", "0", "--explain", "do a thing"], (s) => stdoutLines.push(s), () => {}, {
        adapters,
        auditLogPath,
      });

      const combined = stdoutLines.join("");
      expect(combined).toContain("Routing trace");
      expect(combined).toContain("delegate-free");
    });
  });

  it("blocks and aborts on suspicious content when interactive confirmation is declined", async () => {
    await withTempAuditPath(async (auditLogPath) => {
      const adapter = fakeAdapter("delegate-free", "the answer");
      const adapters: AdapterRegistry = { "delegate-free": adapter };
      const confirm = vi.fn(async () => false);

      const code = await main(
        ["run", "--tier", "2", "here is my key AKIAIOSFODNN7EXAMPLE"],
        () => {},
        () => {},
        { adapters, auditLogPath, isTTY: true, confirm }
      );

      expect(confirm).toHaveBeenCalled();
      expect(code).toBe(1);
      expect(adapter.run).not.toHaveBeenCalled();
    });
  });

  it("proceeds automatically on suspicious content in a non-interactive session", async () => {
    await withTempAuditPath(async (auditLogPath) => {
      const adapter = fakeAdapter("delegate-free", "the answer");
      const adapters: AdapterRegistry = { "delegate-free": adapter };
      const confirm = vi.fn(async () => false);

      const code = await main(
        ["run", "--tier", "2", "here is my key AKIAIOSFODNN7EXAMPLE"],
        () => {},
        () => {},
        { adapters, auditLogPath, isTTY: false, confirm }
      );

      expect(confirm).not.toHaveBeenCalled();
      expect(code).toBe(0);
      expect(adapter.run).toHaveBeenCalled();
    });
  });

  it("never prompts for confirmation on ordinary, non-suspicious task text", async () => {
    await withTempAuditPath(async (auditLogPath) => {
      const adapter = fakeAdapter("delegate-free", "the answer");
      const adapters: AdapterRegistry = { "delegate-free": adapter };
      const confirm = vi.fn(async () => true);

      await main(["run", "--tier", "2", "summarize this article"], () => {}, () => {}, {
        adapters,
        auditLogPath,
        isTTY: true,
        confirm,
      });

      expect(confirm).not.toHaveBeenCalled();
    });
  });
});
