import { appendFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname } from "node:path";
import type { CascadeOutcome, Tier } from "./types.js";

const PREVIEW_LENGTH = 40;
// Tier 2 tasks are already public, so the full text can be logged, but the
// line must still stay reliably under PIPE_BUF so concurrent writers can't
// interleave (spec section 6). Cap it well below typical PIPE_BUF sizes.
const MAX_TIER_2_PREVIEW_LENGTH = 4000;

export interface AuditRecord {
  timestamp: string;
  tier: Tier;
  taskPreview: string;
  taskHash: string;
  attempts: { provider: string; status: string; verified: boolean }[];
  finalStatus: string;
  finalProvider: string | null;
  durationMs: number;
}

export function buildAuditRecord(
  task: string,
  tier: Tier,
  outcome: CascadeOutcome,
  durationMs: number
): AuditRecord {
  const taskHash = createHash("sha256").update(task).digest("hex");
  const taskPreview =
    tier === 2 ? task.slice(0, MAX_TIER_2_PREVIEW_LENGTH) : task.slice(0, PREVIEW_LENGTH);

  return {
    timestamp: new Date().toISOString(),
    tier,
    taskPreview,
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

export async function appendAuditRecord(logPath: string, record: AuditRecord): Promise<void> {
  await mkdir(dirname(logPath), { recursive: true });
  const line = JSON.stringify(record) + "\n";
  await appendFile(logPath, line, { encoding: "utf-8" });
}
