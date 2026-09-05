import {
  runCascade,
  type AdapterRegistry,
  type AttemptBudget,
  type Verifier,
  DEFAULT_TIMEOUT_MS,
} from "./cascade.js";
import type { VerificationResult } from "./verify.js";
import type {
  CascadeOutcome,
  DecompositionOutcome,
  DecomposedSubtask,
  Tier,
} from "./types.js";

// The decomposer step asks an eligible provider (at the parent tier) to return
// ONLY a JSON array of self-contained subtask strings. Dispatch never reasons
// about the content itself; it verifies the shape and routes each subtask.
export const DECOMPOSE_INSTRUCTION =
  'Split the task below into several (2-6) smaller, self-contained subtasks, each of which can be solved independently and references no other subtask. ' +
  'Return ONLY a JSON array of strings — every element must be a single complete subtask description. ' +
  'No prose, no numbering outside the strings, no keys. Example: ["step one", "step two"].';

// Valid plan length bounds. MIN guards against a model "decomposing" into a
// single reworded task (which should just fall back to a normal run). MAX caps
// how many subtasks one invocation will run. MAX_TOTAL_ATTEMPTS bounds the total
// number of provider launches across the decomposer cascade and all subtask
// cascades, so a single --decompose run cannot trigger unbounded subprocess
// launches regardless of cascading failures.
export const MIN_SUBTASKS = 2;
export const MAX_SUBTASKS = 20;
export const MAX_TOTAL_ATTEMPTS = 40;

export interface SubtaskPlanResult {
  /** The cascade that produced (or failed to produce) the subtask plan. */
  outcome: CascadeOutcome;
  /** The validated plan, or null when the decomposer did not return a usable one. */
  plan: string[] | null;
}

/**
 * Parse and validate a decomposer's output into a subtask plan.
 * Returns null when the output is not a usable plan (not JSON, wrong shape,
 * out of bounds, empty elements) so the caller falls back to a normal run.
 */
export function parseSubtaskPlan(output: string): string[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  if (parsed.length < MIN_SUBTASKS || parsed.length > MAX_SUBTASKS) return null;
  const subtasks = parsed.map((e) => (typeof e === "string" ? e.trim() : ""));
  if (subtasks.some((s) => s.length === 0)) return null;
  return subtasks;
}

/**
 * Verifier for the decomposer cascade. Stronger than verifyJsonOutput: it only
 * accepts output that is a *usable* subtask plan, so a provider that returns
 * valid-but-wrong-shape JSON (e.g. {"plan": [...]}) does NOT halt the cascade —
 * the run escalates to the next eligible provider that may produce a real array.
 */
export function verifySubtaskPlan(output: string): VerificationResult {
  if (parseSubtaskPlan(output) === null) {
    return { verified: false, reason: "output is not a usable JSON subtask plan" };
  }
  return { verified: true, reason: "valid subtask plan" };
}

/**
 * Run the decomposition step: a single cascade at the parent tier whose output
 * must be a usable JSON subtask plan. Always returns the cascade outcome so the
 * caller can audit which providers ran, plus the parsed plan (or null).
 */
export async function planSubtasks(
  task: string,
  tier: Tier,
  adapters: AdapterRegistry,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
  budget?: AttemptBudget
): Promise<SubtaskPlanResult> {
  const metaTask = `${DECOMPOSE_INSTRUCTION}\n\n${task}`;
  const outcome = await runCascade(metaTask, tier, adapters, timeoutMs, verifySubtaskPlan, budget);
  return { outcome, plan: parseSubtaskPlan(outcome.finalOutput) };
}

/**
 * Compose subtask outputs into one final output block with greppable
 * delimiters, preserving order.
 */
export function composeOutput(subtasks: DecomposedSubtask[]): string {
  const parts = subtasks.map(
    (s, i) => `[subtask ${i + 1}]\n${s.outcome.finalOutput}`
  );
  return parts.join("\n\n") + "\n";
}

function usable(subtask: DecomposedSubtask): boolean {
  const o = subtask.outcome;
  return (o.finalStatus === "verified" || o.finalStatus === "unverified") &&
    o.finalOutput.trim().length > 0;
}

/**
 * Aggregate per-subtask statuses into one composed status, mirroring the
 * single-run cascade semantics (spec section 5):
 *  - every subtask verified            -> "verified"
 *  - some usable output, not all valid -> "unverified"
 *  - no usable output at all           -> "all-failed"
 */
export function aggregateStatus(subtasks: DecomposedSubtask[]): DecompositionOutcome["finalStatus"] {
  if (subtasks.length === 0) return "all-failed";
  if (subtasks.every((s) => s.outcome.finalStatus === "verified")) return "verified";
  if (subtasks.some(usable)) return "unverified";
  return "all-failed";
}

/** A synthetic outcome for a planned subtask that never ran (budget exhausted). */
function unexecutedOutcome(tier: Tier): CascadeOutcome {
  return { tier, attempts: [], finalOutput: "", finalStatus: "all-failed", finalProvider: null };
}

/**
 * Run a task, optionally decomposed. When a decomposer plan is produced, each
 * subtask runs sequentially through the full cascade at the parent tier and the
 * verified outputs are composed. When no usable plan is produced, falls back to
 * a single cascade on the whole task (never dropping or half-running the task).
 * A shared AttemptBudget bounds total provider launches across all cascades.
 */
export async function runDecomposed(
  task: string,
  tier: Tier,
  adapters: AdapterRegistry,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
  budget: AttemptBudget = { remaining: MAX_TOTAL_ATTEMPTS }
): Promise<DecompositionOutcome> {
  const decompStartedAt = Date.now();
  const planned = await planSubtasks(task, tier, adapters, timeoutMs, budget);
  const decomposerDurationMs = Date.now() - decompStartedAt;

  if (!planned.plan) {
    const startedAt = Date.now();
    const outcome = await runCascade(task, tier, adapters, timeoutMs, undefined, budget);
    return {
      decomposed: false,
      decomposerOutcome: planned.outcome,
      decomposerDurationMs,
      subtasks: [{ subtask: task, outcome, durationMs: Date.now() - startedAt }],
      finalOutput: outcome.finalOutput,
      finalStatus: outcome.finalStatus,
    };
  }

  const subtasks: DecomposedSubtask[] = [];
  for (const subtask of planned.plan) {
    // Stop launching subtasks once the shared attempt budget is exhausted.
    if (budget.remaining <= 0) {
      subtasks.push({ subtask, outcome: unexecutedOutcome(tier), durationMs: 0 });
      continue;
    }
    const startedAt = Date.now();
    const outcome = await runCascade(subtask, tier, adapters, timeoutMs, undefined, budget);
    subtasks.push({ subtask, outcome, durationMs: Date.now() - startedAt });
  }

  const finalStatus = aggregateStatus(subtasks);
  // When nothing produced usable output, emit an empty final output rather than
  // a block of empty [subtask n] headers.
  const finalOutput = finalStatus === "all-failed" ? "" : composeOutput(subtasks);

  return {
    decomposed: true,
    decomposerOutcome: planned.outcome,
    decomposerDurationMs,
    subtasks,
    finalOutput,
    finalStatus,
  };
}
