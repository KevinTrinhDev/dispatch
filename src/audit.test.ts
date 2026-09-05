// src/audit.test.ts
import { describe, expect, it, afterEach } from "vitest";
import { readFile, rm, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildAuditRecord, buildDecompositionSummaryRecord, appendAuditRecord } from "./audit.js";
import type { CascadeOutcome } from "./types.js";

const sampleOutcome: CascadeOutcome = {
  tier: 0,
  attempts: [
    {
      provider: "delegate-free",
      result: { status: "ok", output: "the secret answer", exitCode: 0 },
      verified: true,
      verificationReason: "non-empty, no refusal phrases detected",
    },
  ],
  finalOutput: "the secret answer",
  finalStatus: "verified",
  finalProvider: "delegate-free",
};

const LONG_SECRET_TASK =
  "here is my private key -----BEGIN RSA PRIVATE KEY----- MIIEowIBAAKCAQEA1234567890";

describe("buildAuditRecord", () => {
  it("truncates task text to 40 chars for tier 0", () => {
    const record = buildAuditRecord(LONG_SECRET_TASK, 0, sampleOutcome, 1234);
    expect(record.taskPreview.length).toBeLessThanOrEqual(40);
    expect(record.taskPreview).not.toContain("BEGIN RSA PRIVATE KEY");
  });

  it("truncates task text to 40 chars for tier 1", () => {
    const record = buildAuditRecord(LONG_SECRET_TASK, 1, sampleOutcome, 1234);
    expect(record.taskPreview.length).toBeLessThanOrEqual(40);
  });

  it("keeps the full task text for tier 2", () => {
    const record = buildAuditRecord(LONG_SECRET_TASK, 2, { ...sampleOutcome, tier: 2 }, 1234);
    expect(record.taskPreview).toBe(LONG_SECRET_TASK);
  });

  it("caps the tier 2 taskPreview at MAX_TIER_2_PREVIEW_LENGTH for a very long task", () => {
    const hugeTask = "x".repeat(10_000);
    const record = buildAuditRecord(hugeTask, 2, { ...sampleOutcome, tier: 2 }, 1234);
    expect(record.taskPreview.length).toBeLessThanOrEqual(4000);
  });

  it("includes the durationMs passed in", () => {
    const record = buildAuditRecord(LONG_SECRET_TASK, 0, sampleOutcome, 987);
    expect(record.durationMs).toBe(987);
  });

  it("always includes a sha256 hash of the full task text, regardless of tier", () => {
    const record = buildAuditRecord(LONG_SECRET_TASK, 0, sampleOutcome, 1234);
    expect(record.taskHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("never serializes the full secret text for tier 0, even inside JSON.stringify", () => {
    const record = buildAuditRecord(LONG_SECRET_TASK, 0, sampleOutcome, 1234);
    const serialized = JSON.stringify(record);
    expect(serialized).not.toContain("MIIEowIBAAKCAQEA1234567890");
  });
});

describe("appendAuditRecord", () => {
  let dir: string;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("creates the log directory and appends a valid JSON line", async () => {
    dir = await mkdtemp(join(tmpdir(), "dispatch-audit-"));
    const logPath = join(dir, "nested", "audit.jsonl");
    const record = buildAuditRecord("do a thing", 2, sampleOutcome, 1234);

    await appendAuditRecord(logPath, record);

    const content = await readFile(logPath, "utf-8");
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toEqual(record);
  });

  it("appends multiple concurrent writes as separate valid JSON lines", async () => {
    dir = await mkdtemp(join(tmpdir(), "dispatch-audit-"));
    const logPath = join(dir, "audit.jsonl");
    const recordA = buildAuditRecord("task A", 2, sampleOutcome, 1234);
    const recordB = buildAuditRecord("task B", 2, sampleOutcome, 1234);

    await Promise.all([appendAuditRecord(logPath, recordA), appendAuditRecord(logPath, recordB)]);

    const content = await readFile(logPath, "utf-8");
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });
});

describe("buildDecompositionSummaryRecord", () => {
  const subtasks = [
    { status: "verified" as const },
    { status: "verified" as const },
    { status: "unverified" as const },
    { status: "all-failed" as const },
  ];

  it("redacts the parent task text for tier 0", () => {
    const record = buildDecompositionSummaryRecord(LONG_SECRET_TASK, 0, subtasks, "unverified", 5000);
    expect(record.taskPreview.length).toBeLessThanOrEqual(40);
    expect(JSON.stringify(record)).not.toContain("MIIEowIBAAKCAQEA1234567890");
    expect(record.taskHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("counts verified and failed subtasks and records the aggregate status", () => {
    const record = buildDecompositionSummaryRecord("build an app", 2, subtasks, "unverified", 5000);
    expect(record.subtaskCount).toBe(4);
    expect(record.verifiedCount).toBe(2);
    expect(record.failedCount).toBe(1);
    expect(record.finalStatus).toBe("unverified");
    expect(record.kind).toBe("decomposition");
  });

  it("keeps full parent text for tier 2", () => {
    const record = buildDecompositionSummaryRecord(LONG_SECRET_TASK, 2, subtasks, "verified", 5000);
    expect(record.taskPreview).toBe(LONG_SECRET_TASK);
  });
});
