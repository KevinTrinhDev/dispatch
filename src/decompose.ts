import {
  runCascade,
  type AdapterRegistry,
  DEFAULT_TIMEOUT_MS,
} from "./cascade.js";
import { verifyJsonOutput } from "./verify.js";
import type { DecompositionOutcome, DecomposedSubtask, Tier } from "./types.js";

// The decomposer step asks an eligible provider (at the parent tier) to return
// ONLY a JSON array of self-contained subtask strings. Dispatch never reasons
// about the content itself; it verifies the shape and routes each subtask.
export const DECOMPOSE_INSTRUCTION =
  'Split the task below into several (2-6) smaller, self-contained subtasks, each of which can be solved independently and references no other subtask. ' +
  'Return ONLY a JSON array of strings — every element must be a single complete subtask description. ' +
  'No prose, no numbering outside the strings, no keys. Example: ["step one", "step two"].';

// Valid plan length bounds. MIN guards against a model "decomposing" into a
// single reworded task (which should just fall back to a normal run). MAX is a
// safety cap bounding how many provider calls one invocation can trigger.
export const MIN_SUBTASKS = 2;
export const MAX_SUBTASKS = 20;

export interface SubtaskPlanResult {
  plan: string[];
  decompositionOutput: string;
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
 * Run the decomposition step: a single cascade at the parent tier whose output
 * must be a valid JSON subtask plan. Returns the validated plan, or null if no
 * eligible provider produced one (caller should fall back to a normal run).
 */
export async function planSubtasks(
  task: string,
  tier: Tier,
  adapters: AdapterRegistry,
  timeoutMs: number = DEFAULT_TIMEOUT_MS
): Promise<SubtaskPlanResult | null> {
  const metaTask = `${DECOMPOSE_INSTRUCTION}\n\n${task}`;
  const outcome = await runCascade(metaTask, tier, adapters, timeoutMs, verifyJsonOutput);
  const plan = parseSubtaskPlan(outcome.finalOutput);
  if (!plan) return null;
  return { plan, decompositionOutput: outcome.finalOutput };
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

/**
 * Run a task, optionally decomposed. When a decomposer plan is produced, each
 * subtask runs sequentially through the full cascade at the parent tier and the
 * verified outputs are composed. When no usable plan is produced, falls back to
 * a single cascade on the whole task (never dropping or half-running the task).
 */
export async function runDecomposed(
  task: string,
  tier: Tier,
  adapters: AdapterRegistry,
  timeoutMs: number = DEFAULT_TIMEOUT_MS
): Promise<DecompositionOutcome> {
  const planned = await planSubtasks(task, tier, adapters, timeoutMs);

  if (!planned) {
    const startedAt = Date.now();
    const outcome = await runCascade(task, tier, adapters, timeoutMs);
    return {
      decomposed: false,
      subtasks: [{ subtask: task, outcome, durationMs: Date.now() - startedAt }],
      finalOutput: outcome.finalOutput,
      finalStatus: outcome.finalStatus,
    };
  }

  const subtasks: DecomposedSubtask[] = [];
  for (const subtask of planned.plan) {
    const startedAt = Date.now();
    const outcome = await runCascade(subtask, tier, adapters, timeoutMs);
    subtasks.push({ subtask, outcome, durationMs: Date.now() - startedAt });
  }

  const finalStatus = aggregateStatus(subtasks);
  // When nothing produced usable output, emit an empty final output rather than
  // a block of empty [subtask n] headers.
  const finalOutput = finalStatus === "all-failed" ? "" : composeOutput(subtasks);

  return {
    decomposed: true,
    subtasks,
    finalOutput,
    finalStatus,
  };
}
