import { describe, expect, it, vi } from "vitest";
import type { ProviderAdapter, ProviderName } from "./types.js";
import {
  runDecomposed,
  planSubtasks,
  parseSubtaskPlan,
  composeOutput,
  aggregateStatus,
  DECOMPOSE_INSTRUCTION,
  MIN_SUBTASKS,
  MAX_SUBTASKS,
} from "./decompose.js";
import type { AdapterRegistry } from "./cascade.js";
import type { DecomposedSubtask } from "./types.js";

// A routing adapter that answers the decomposition meta-task with a JSON plan
// and otherwise answers subtasks with a distinct per-task answer.
function planningAdapter(
  name: ProviderName,
  plan: string[]
): { adapter: ProviderAdapter; calls: string[] } {
  const calls: string[] = [];
  const adapter: ProviderAdapter = {
    name,
    run: vi.fn(async (task: string) => {
      calls.push(task);
      if (task.includes(DECOMPOSE_INSTRUCTION)) {
        return { status: "ok", output: JSON.stringify(plan), exitCode: 0 };
      }
      return { status: "ok", output: `answer for: ${task}`, exitCode: 0 };
    }),
  };
  return { adapter, calls };
}

describe("parseSubtaskPlan", () => {
  it("accepts a valid array of non-empty strings", () => {
    expect(parseSubtaskPlan(JSON.stringify(["step one", "step two", "step three"]))).toEqual([
      "step one",
      "step two",
      "step three",
    ]);
  });

  it("returns null for non-JSON output", () => {
    expect(parseSubtaskPlan("I cannot do that")).toBeNull();
  });

  it("returns null for a non-array JSON value", () => {
    expect(parseSubtaskPlan('{"a":1}')).toBeNull();
  });

  it("returns null for an empty array", () => {
    expect(parseSubtaskPlan("[]")).toBeNull();
  });

  it("returns null for a single-element plan (no real decomposition)", () => {
    expect(parseSubtaskPlan(JSON.stringify(["only one"]))).toBeNull();
  });

  it("returns null when an element is empty or whitespace after trim", () => {
    expect(parseSubtaskPlan(JSON.stringify(["a", "   "]))).toBeNull();
  });

  it(`returns null above the MAX_SUBTASKS cap of ${MAX_SUBTASKS}`, () => {
    const many = Array.from({ length: MAX_SUBTASKS + 1 }, (_, i) => `t${i}`);
    expect(parseSubtaskPlan(JSON.stringify(many))).toBeNull();
  });

  it(`accepts a plan at the MIN_SUBTASKS boundary of ${MIN_SUBTASKS}`, () => {
    expect(parseSubtaskPlan(JSON.stringify(["a", "b"]))).toEqual(["a", "b"]);
  });
});

describe("runDecomposed", () => {
  it("splits a task, routes each subtask at the parent tier, and composes outputs", async () => {
    const free = planningAdapter("delegate-free", ["part A", "part B"]);
    const claudeRun = vi.fn(async () => {
      throw new Error("claude should not run when delegate-free succeeds");
    });
    const adapters: AdapterRegistry = {
      "delegate-free": free.adapter,
      claude: { name: "claude", run: claudeRun },
    };

    const outcome = await runDecomposed("do the whole thing", 1, adapters);

    expect(outcome.decomposed).toBe(true);
    expect(outcome.subtasks).toHaveLength(2);
    expect(outcome.finalStatus).toBe("verified");
    // Each sub-cascade ran at the parent tier.
    expect(outcome.subtasks.every((s) => s.outcome.tier === 1)).toBe(true);
    // 1 decomposition call + 2 subtask calls, all on delegate-free.
    expect(free.calls).toHaveLength(3);
    expect(claudeRun).not.toHaveBeenCalled();
    // Composed output contains both subtask markers and answers.
    expect(outcome.finalOutput).toContain("[subtask 1]");
    expect(outcome.finalOutput).toContain("[subtask 2]");
    expect(outcome.finalOutput).toContain("answer for: part A");
    expect(outcome.finalOutput).toContain("answer for: part B");
  });

  it("falls back to a single cascade when the decomposer output is not a valid plan", async () => {
    const fallbackRun = vi.fn(async (task: string) => ({
      status: "ok" as const,
      output: `whole-task answer for: ${task}`,
      exitCode: 0,
    }));
    const adapters: AdapterRegistry = { "delegate-free": { name: "delegate-free", run: fallbackRun } };

    const outcome = await runDecomposed("do the whole thing", 1, adapters);

    // Fallback path: first call is the failed decomposition attempt, second is
    // the whole-task run. assert decomposed=false and a usable answer came back.
    expect(outcome.decomposed).toBe(false);
    expect(outcome.subtasks).toHaveLength(1);
    expect(outcome.finalStatus).toBe("verified");
    expect(outcome.finalOutput).toContain("whole-task answer for:");
  });

  it("never routes any part of a tier-0 run to a non-local provider", async () => {
    const gazeRun = vi.fn(async () => {
      throw new Error("gaze must never run for tier 0");
    });
    const claudeRun = vi.fn(async () => {
      throw new Error("claude must never run for tier 0");
    });
    const free = planningAdapter("delegate-free", ["a", "b"]);
    const adapters: AdapterRegistry = {
      "delegate-free": free.adapter,
      claude: { name: "claude", run: claudeRun },
      gaze: { name: "gaze", run: gazeRun },
    };

    const outcome = await runDecomposed("secret tier 0 work", 0, adapters);

    expect(outcome.decomposed).toBe(true);
    expect(claudeRun).not.toHaveBeenCalled();
    expect(gazeRun).not.toHaveBeenCalled();
    expect(free.calls).toHaveLength(3); // decomposition + 2 subtasks, all local
  });

  it("returns all-failed aggregate when no subtask produces usable output", async () => {
    const brokenRun = vi.fn(async (task: string) => {
      if (task.includes(DECOMPOSE_INSTRUCTION)) {
        return { status: "ok", output: JSON.stringify(["a", "b"]), exitCode: 0 };
      }
      return { status: "error", message: "boom" };
    });
    const adapters: AdapterRegistry = { "delegate-free": { name: "delegate-free", run: brokenRun } };

    const outcome = await runDecomposed("do the thing", 0, adapters);

    expect(outcome.decomposed).toBe(true);
    expect(outcome.finalStatus).toBe("all-failed");
    expect(outcome.finalOutput).toBe("");
  });

  it("honors the shared attempt budget and stops launching subtasks when exhausted", async () => {
    const free = planningAdapter("delegate-free", ["a", "b"]);
    const adapters: AdapterRegistry = { "delegate-free": free.adapter };
    // Budget of 1: consumed entirely by the decomposer cascade, so no subtask runs.
    const outcome = await runDecomposed("do the thing", 0, adapters, 120_000, { remaining: 1 });

    expect(outcome.decomposed).toBe(true);
    expect(free.calls).toHaveLength(1); // only the decomposer cascade launched
    // Both planned subtasks were not executed -> aggregate cannot claim success.
    expect(outcome.subtasks).toHaveLength(2);
    expect(outcome.subtasks.every((s) => s.outcome.finalStatus === "all-failed")).toBe(true);
    expect(outcome.finalStatus).toBe("all-failed");
  });

  it("runs subtasks concurrently up to the parallel limit and preserves plan order", async () => {
    let active = 0;
    let maxActive = 0;
    const plan = ["part 1", "part 2", "part 3", "part 4"];
    const adapter: ProviderAdapter = {
      name: "delegate-free",
      run: async (task: string) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 4));
        active -= 1;
        if (task.includes(DECOMPOSE_INSTRUCTION)) {
          return { status: "ok", output: JSON.stringify(plan), exitCode: 0 };
        }
        return { status: "ok", output: `answer for ${task}`, exitCode: 0 };
      },
    };

    const outcome = await runDecomposed("do the thing", 0, { "delegate-free": adapter }, 120_000, undefined, 3);

    expect(outcome.decomposed).toBe(true);
    expect(outcome.subtasks).toHaveLength(plan.length);
    // Results are still reported in plan order, and <=3 subtasks were in flight.
    expect(outcome.subtasks.map((s) => s.subtask)).toEqual(plan);
    expect(outcome.subtasks.every((s) => s.outcome.finalStatus === "verified")).toBe(true);
    expect(maxActive).toBe(3);
  });

  it("runs subtasks sequentially (max 1 in flight) when parallel is 1", async () => {
    let active = 0;
    let maxActive = 0;
    const plan = ["part 1", "part 2", "part 3"];
    const adapter: ProviderAdapter = {
      name: "delegate-free",
      run: async (task: string) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 2));
        active -= 1;
        if (task.includes(DECOMPOSE_INSTRUCTION)) {
          return { status: "ok", output: JSON.stringify(plan), exitCode: 0 };
        }
        return { status: "ok", output: `answer for ${task}`, exitCode: 0 };
      },
    };

    await runDecomposed("do the thing", 0, { "delegate-free": adapter }, 120_000, undefined, 1);
    expect(maxActive).toBe(1);
  });
});

describe("planSubtasks", () => {
  it("returns the validated plan when a provider returns a valid JSON plan", async () => {
    const adapters: AdapterRegistry = {
      "delegate-free": {
        name: "delegate-free",
        run: async () => ({ status: "ok", output: JSON.stringify(["x", "y"]), exitCode: 0 }),
      },
    };
    const result = await planSubtasks("task", 0, adapters);
    expect(result.plan).toEqual(["x", "y"]);
    expect(result.outcome.finalStatus).toBe("verified");
  });

  it("returns a null plan but the cascade outcome when no provider returns a usable plan", async () => {
    const adapters: AdapterRegistry = {
      "delegate-free": {
        name: "delegate-free",
        run: async () => ({ status: "ok", output: "here is my plan in prose", exitCode: 0 }),
      },
    };
    const result = await planSubtasks("task", 0, adapters);
    expect(result.plan).toBeNull();
    // The cascade that ran is still returned so its provider launches are auditable.
    expect(result.outcome.attempts.map((a) => a.provider)).toEqual(["delegate-free"]);
  });

  it("escalates past wrong-shape-but-valid JSON to a provider that returns a real array", async () => {
    const objectJson = { name: "delegate-free", run: async () => ({ status: "ok", output: '{"plan":["x","y"]}', exitCode: 0 }) };
    const arrayJson = { name: "claude", run: async () => ({ status: "ok", output: JSON.stringify(["x", "y"]), exitCode: 0 }) };
    const adapters: AdapterRegistry = { "delegate-free": objectJson, claude: arrayJson };

    const result = await planSubtasks("task", 1, adapters);
    expect(result.plan).toEqual(["x", "y"]);
    expect(result.outcome.attempts.map((a) => a.provider)).toEqual(["delegate-free", "claude"]);
  });
});

describe("composeOutput / aggregateStatus", () => {
  const subtask = (status: "verified" | "unverified" | "all-failed", output: string): DecomposedSubtask => ({
    subtask: "s",
    durationMs: 1,
    outcome: {
      tier: 1,
      attempts: [],
      finalOutput: output,
      finalStatus: status,
      finalProvider: status === "all-failed" ? null : "delegate-free",
    },
  });

  it("composes delimited blocks in order", () => {
    const out = composeOutput([subtask("verified", "one"), subtask("verified", "two")]);
    expect(out).toContain("[subtask 1]\none");
    expect(out).toContain("[subtask 2]\ntwo");
  });

  it("maps all-verified to verified", () => {
    expect(aggregateStatus([subtask("verified", "a"), subtask("verified", "b")])).toBe("verified");
  });

  it("maps mixed to unverified when some output is usable", () => {
    expect(aggregateStatus([subtask("verified", "a"), subtask("unverified", "half")])).toBe("unverified");
  });

  it("maps all-failed to all-failed", () => {
    expect(aggregateStatus([subtask("all-failed", ""), subtask("all-failed", "")])).toBe("all-failed");
  });

  it("returns all-failed for no subtasks", () => {
    expect(aggregateStatus([])).toBe("all-failed");
  });
});
