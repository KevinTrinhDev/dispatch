import { describe, expect, it, vi } from "vitest";
import { readFile, rm, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "./cli.js";
import type { AdapterRegistry } from "./cascade.js";
import type { ProviderAdapter } from "./types.js";
import { DECOMPOSE_INSTRUCTION } from "./decompose.js";

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

  it("prints help and exits 0 for --help", async () => {
    const stdoutLines: string[] = [];
    const code = await main(["--help"], (s) => stdoutLines.push(s), () => {});
    expect(code).toBe(0);
    expect(stdoutLines.join("")).toContain("dispatch run --tier");
  });

  it("prints the version and exits 0 for --version", async () => {
    const stdoutLines: string[] = [];
    const code = await main(["--version"], (s) => stdoutLines.push(s), () => {});
    expect(code).toBe(0);
    expect(stdoutLines.join("").trim()).toMatch(/^\d+\.\d+\.\d+$/);
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

  it("prints an unverified warning to stderr when the final status is unverified, and not when verified", async () => {
    await withTempAuditPath(async (auditLogPath) => {
      const partialAdapter: ProviderAdapter = {
        name: "delegate-free",
        run: vi.fn(async () => ({ status: "partial" as const, output: "half an answer", reason: "cut off" })),
      };
      const adapters: AdapterRegistry = { "delegate-free": partialAdapter };
      const stderrLines: string[] = [];

      const code = await main(["run", "--tier", "0", "do a thing"], () => {}, (s) => stderrLines.push(s), {
        adapters,
        auditLogPath,
      });

      expect(code).toBe(0);
      expect(stderrLines.join("")).toMatch(/unverified|could not be verified/i);
    });

    await withTempAuditPath(async (auditLogPath) => {
      const adapters: AdapterRegistry = { "delegate-free": fakeAdapter("delegate-free", "the answer") };
      const stderrLines: string[] = [];

      const code = await main(["run", "--tier", "0", "do a thing"], () => {}, (s) => stderrLines.push(s), {
        adapters,
        auditLogPath,
      });

      expect(code).toBe(0);
      expect(stderrLines.join("")).not.toMatch(/could not be verified/i);
    });
  });

  it("includes a failed attempt's reason/message in --explain output", async () => {
    await withTempAuditPath(async (auditLogPath) => {
      const failingAdapter: ProviderAdapter = {
        name: "delegate-free",
        run: vi.fn(async () => ({ status: "error" as const, message: "boom: nonexistent subcommand" })),
      };
      const adapters: AdapterRegistry = { "delegate-free": failingAdapter, claude: fakeAdapter("claude", "the answer") };
      const stdoutLines: string[] = [];

      await main(["run", "--tier", "1", "--explain", "do a thing"], (s) => stdoutLines.push(s), () => {}, {
        adapters,
        auditLogPath,
      });

      const combined = stdoutLines.join("");
      expect(combined).toContain("boom: nonexistent subcommand");
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

  it("decomposes a task and composes per-subtask output (--decompose)", async () => {
    await withTempAuditPath(async (auditLogPath) => {
      const decomposeFree: ProviderAdapter = {
        name: "delegate-free",
        run: async (task) => {
          if (task.includes(DECOMPOSE_INSTRUCTION)) {
            return { status: "ok", output: JSON.stringify(["part one", "part two"]), exitCode: 0 };
          }
          return { status: "ok", output: `answer for ${task}`, exitCode: 0 };
        },
      };
      const adapters: AdapterRegistry = { "delegate-free": decomposeFree };
      const stdoutLines: string[] = [];

      const code = await main(
        ["run", "--tier", "1", "--decompose", "build the whole app"],
        (s) => stdoutLines.push(s),
        () => {},
        { adapters, auditLogPath }
      );

      expect(code).toBe(0);
      const combined = stdoutLines.join("");
      expect(combined).toContain("[subtask 1]");
      expect(combined).toContain("[subtask 2]");
      expect(combined).toContain("answer for part one");
      expect(combined).toContain("answer for part two");
    });
  });

  it("writes one per-subtask audit record plus one decomposition summary (--decompose)", async () => {
    await withTempAuditPath(async (auditLogPath) => {
      // Long texts whose sensitive tails sit well beyond the 40-char preview.
      const parentTask = "do not log this private thing " + "x".repeat(60) + " PARENT-SECRET-TAIL-9876";
      const secretPartOne = "an internal plan detail " + "y".repeat(60) + " SUBTASK-SECRET-TAIL-1234";
      const decomposeFree: ProviderAdapter = {
        name: "delegate-free",
        run: async (task) => {
          if (task.includes(DECOMPOSE_INSTRUCTION)) {
            return { status: "ok", output: JSON.stringify([secretPartOne, "part two is public"]), exitCode: 0 };
          }
          return { status: "ok", output: `answer for ${task}`, exitCode: 0 };
        },
      };
      const adapters: AdapterRegistry = { "delegate-free": decomposeFree };

      await main(["run", "--tier", "0", "--decompose", parentTask], () => {}, () => {}, {
        adapters,
        auditLogPath,
      });

      const content = await readFile(auditLogPath, "utf-8");
      const records = content.trim().split("\n").map((l) => JSON.parse(l));
      expect(records).toHaveLength(4); // decomposer + 2 subtasks + summary
      const summary = records.find((r) => r.kind === "decomposition");
      expect(summary).toBeDefined();
      expect(summary.subtaskCount).toBe(2);
      // The decomposer cascade is audited as its own record.
      expect(records.some((r) => r.role === "decomposer")).toBe(true);
      // No tier-0 parent or subtask sensitive tail may leak into the log.
      expect(content).not.toContain("PARENT-SECRET-TAIL-9876");
      expect(content).not.toContain("SUBTASK-SECRET-TAIL-1234");
    });
  });

  it("falls back to a single run when --decompose cannot produce a valid plan", async () => {
    await withTempAuditPath(async (auditLogPath) => {
      const proseAdapter: ProviderAdapter = {
        name: "delegate-free",
        run: async (task) => ({ status: "ok", output: `whole answer for ${task}`, exitCode: 0 }),
      };
      const adapters: AdapterRegistry = { "delegate-free": proseAdapter };
      const stdoutLines: string[] = [];

      const code = await main(
        ["run", "--tier", "1", "--decompose", "do a thing"],
        (s) => stdoutLines.push(s),
        () => {},
        { adapters, auditLogPath }
      );

      expect(code).toBe(0);
      const combined = stdoutLines.join("");
      expect(combined).toContain("whole answer for do a thing");
      // No decomposition summary was written because decomposition fell back.
      const content = await readFile(auditLogPath, "utf-8");
      const records = content.trim().split("\n").map((l) => JSON.parse(l));
      expect(records.some((r) => r.kind === "decomposition")).toBe(false);
    });
  });

  it("prints a per-subtask decomposition trace with --explain", async () => {
    await withTempAuditPath(async (auditLogPath) => {
      const decomposeFree: ProviderAdapter = {
        name: "delegate-free",
        run: async (task) => {
          if (task.includes(DECOMPOSE_INSTRUCTION)) {
            return { status: "ok", output: JSON.stringify(["one", "two"]), exitCode: 0 };
          }
          return { status: "ok", output: `answer for ${task}`, exitCode: 0 };
        },
      };
      const adapters: AdapterRegistry = { "delegate-free": decomposeFree };
      const stdoutLines: string[] = [];

      await main(
        ["run", "--tier", "1", "--decompose", "--explain", "build it"],
        (s) => stdoutLines.push(s),
        () => {},
        { adapters, auditLogPath }
      );

      const combined = stdoutLines.join("");
      expect(combined).toContain("Decomposition trace");
      expect(combined).toContain("Subtask 1");
      expect(combined).toContain("Subtask 2");
    });
  });
});
