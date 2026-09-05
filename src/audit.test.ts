// src/audit.test.ts
import { describe, expect, it, afterEach } from "vitest";
import { readFile, rm, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildAuditRecord, appendAuditRecord } from "./audit.js";
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
    const record = buildAuditRecord(LONG_SECRET_TASK, 0, sampleOutcome);
    expect(record.taskPreview.length).toBeLessThanOrEqual(40);
    expect(record.taskPreview).not.toContain("BEGIN RSA PRIVATE KEY");
  });

  it("truncates task text to 40 chars for tier 1", () => {
    const record = buildAuditRecord(LONG_SECRET_TASK, 1, sampleOutcome);
    expect(record.taskPreview.length).toBeLessThanOrEqual(40);
  });

  it("keeps the full task text for tier 2", () => {
    const record = buildAuditRecord(LONG_SECRET_TASK, 2, { ...sampleOutcome, tier: 2 });
    expect(record.taskPreview).toBe(LONG_SECRET_TASK);
  });

  it("always includes a sha256 hash of the full task text, regardless of tier", () => {
    const record = buildAuditRecord(LONG_SECRET_TASK, 0, sampleOutcome);
    expect(record.taskHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("never serializes the full secret text for tier 0, even inside JSON.stringify", () => {
    const record = buildAuditRecord(LONG_SECRET_TASK, 0, sampleOutcome);
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
    const record = buildAuditRecord("do a thing", 2, sampleOutcome);

    await appendAuditRecord(logPath, record);

    const content = await readFile(logPath, "utf-8");
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toEqual(record);
  });

  it("appends multiple concurrent writes as separate valid JSON lines", async () => {
    dir = await mkdtemp(join(tmpdir(), "dispatch-audit-"));
    const logPath = join(dir, "audit.jsonl");
    const recordA = buildAuditRecord("task A", 2, sampleOutcome);
    const recordB = buildAuditRecord("task B", 2, sampleOutcome);

    await Promise.all([appendAuditRecord(logPath, recordA), appendAuditRecord(logPath, recordB)]);

    const content = await readFile(logPath, "utf-8");
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });
});
