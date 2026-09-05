import { appendFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname } from "node:path";
import type { CascadeOutcome, Tier } from "./types.js";

const PREVIEW_LENGTH = 40;
// Tier 2 tasks are already public, so the full text can be logged, but the
// line must still stay reliably under PIPE_BUF so concurrent writers can't
// interleave (spec section 6). Cap it well below typical PIPE_BUF sizes.
const MAX_TIER_2_PREVIEW_LENGTH = 4000;

export type AuditRole = "run" | "decomposer" | "subtask";

export interface AuditRecord {
  timestamp: string;
  tier: Tier;
  role: AuditRole;
  taskPreview: string;
  taskHash: string;
  attempts: { provider: string; status: string; verified: boolean }[];
  finalStatus: string;
  finalProvider: string | null;
  durationMs: number;
}

export interface DecompositionSummaryRecord {
  kind: "decomposition";
  timestamp: string;
  tier: Tier;
  taskPreview: string;
  taskHash: string;
  subtaskCount: number;
  verifiedCount: number;
  failedCount: number;
  finalStatus: string;
  durationMs: number;
}

function hash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

// Shared tier-redaction rule (spec section 6): tier 2 may log the full task
// text; tiers 0 and 1 may only log a short preview plus a hash. Applied to the
// parent task and to every decomposed subtask independently.
export function redactTaskText(tier: Tier, text: string): { preview: string; taskHash: string } {
  const taskHash = hash(text);
  const taskPreview =
    tier === 2 ? text.slice(0, MAX_TIER_2_PREVIEW_LENGTH) : text.slice(0, PREVIEW_LENGTH);
  return { preview: taskPreview, taskHash };
}

export function buildAuditRecord(
  task: string,
  tier: Tier,
  outcome: CascadeOutcome,
  durationMs: number,
  role: AuditRole = "run"
): AuditRecord {
  const { preview, taskHash } = redactTaskText(tier, task);

  return {
    timestamp: new Date().toISOString(),
    tier,
    role,
    taskPreview: preview,
    taskHash,
    attempts: outcome.attempts.map((a) => ({
      provider: a.provider,
      status: a.result.status,
      verified: a.verified,
    })),
    finalStatus: outcome.finalStatus,
    finalProvider: outcome.finalProvider,
    durationMs,
  };
}

export function buildDecompositionSummaryRecord(
  task: string,
  tier: Tier,
  subtasks: { status: "verified" | "unverified" | "all-failed" }[],
  finalStatus: string,
  durationMs: number
): DecompositionSummaryRecord {
  const { preview, taskHash } = redactTaskText(tier, task);
  const verifiedCount = subtasks.filter((s) => s.status === "verified").length;
  const failedCount = subtasks.filter((s) => s.status === "all-failed").length;

  return {
    kind: "decomposition",
    timestamp: new Date().toISOString(),
    tier,
    taskPreview: preview,
    taskHash,
    subtaskCount: subtasks.length,
    verifiedCount,
    failedCount,
    finalStatus,
    durationMs,
  };
}

export type AuditLogRecord = AuditRecord | DecompositionSummaryRecord;

export async function appendAuditRecord(logPath: string, record: AuditLogRecord): Promise<void> {
  await mkdir(dirname(logPath), { recursive: true });
  const line = JSON.stringify(record) + "\n";
  await appendFile(logPath, line, { encoding: "utf-8" });
}
