import { appendFile, mkdir, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname } from "node:path";
import type { Tier } from "./types.js";

// Shared knowledge store ("memory") across runs.
//
// Tier model (mirrors the audit log's redaction rule): only TIER 2 tasks are
// public, so only their full text + verified output may be persisted. Tier 0
// and tier 1 tasks are NEVER stored, so the knowledge store cannot become a
// second copy of private content. If a caller asks to recall a task whose tier
// forbids storage, there is simply nothing to return.

export interface MemoryRecord {
  kind: "knowledge";
  taskHash: string;
  tier: Tier;
  task: string;
  output: string;
  finalProvider: string | null;
  storedAt: string;
}

/** True only for tier 2 — the sole tier whose content is safe to persist. */
export function isStorableTier(tier: Tier): boolean {
  return tier === 2;
}

export function buildMemoryRecord(
  task: string,
  tier: Tier,
  output: string,
  finalProvider: string | null
): MemoryRecord {
  return {
    kind: "knowledge",
    taskHash: createHash("sha256").update(task).digest("hex"),
    tier,
    task,
    output,
    finalProvider,
    storedAt: new Date().toISOString(),
  };
}

/** Persist a verified result for recall by later runs. Tier-gated internally. */
export async function storeVerified(
  knowledgePath: string,
  task: string,
  tier: Tier,
  output: string,
  finalProvider: string | null
): Promise<void> {
  if (!isStorableTier(tier)) return;
  if (output.trim().length === 0) return;
  await mkdir(dirname(knowledgePath), { recursive: true });
  const record = buildMemoryRecord(task, tier, output, finalProvider);
  await appendFile(knowledgePath, JSON.stringify(record) + "\n", { encoding: "utf-8" });
}

/** Return the newest stored result whose exact task text matches (tier 2 only). */
export async function recallExact(
  knowledgePath: string,
  task: string,
  tier: Tier
): Promise<MemoryRecord | null> {
  if (!isStorableTier(tier)) return null;
  const taskHash = createHash("sha256").update(task).digest("hex");
  let lines: string[];
  try {
    lines = (await readFile(knowledgePath, "utf-8")).split("\n");
  } catch {
    return null; // no store yet
  }
  // Newest first.
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      const rec = JSON.parse(line) as MemoryRecord;
      if (rec.kind === "knowledge" && rec.tier === 2 && rec.taskHash === taskHash) {
        return rec;
      }
    } catch {
      // skip malformed lines rather than failing the whole recall
    }
  }
  return null;
}
