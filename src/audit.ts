import { appendFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname } from "node:path";
import type { CascadeOutcome, Tier } from "./types.js";

const PREVIEW_LENGTH = 40;

export interface AuditRecord {
  timestamp: string;
  tier: Tier;
  taskPreview: string;
  taskHash: string;
  attempts: { provider: string; status: string; verified: boolean }[];
  finalStatus: string;
  finalProvider: string | null;
}

export function buildAuditRecord(task: string, tier: Tier, outcome: CascadeOutcome): AuditRecord {
  const taskHash = createHash("sha256").update(task).digest("hex");
  const taskPreview = tier === 2 ? task : task.slice(0, PREVIEW_LENGTH);

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
  };
}

export async function appendAuditRecord(logPath: string, record: AuditRecord): Promise<void> {
  await mkdir(dirname(logPath), { recursive: true });
  const line = JSON.stringify(record) + "\n";
  await appendFile(logPath, line, { encoding: "utf-8" });
}
