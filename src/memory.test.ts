import { describe, expect, it, afterEach } from "vitest";
import { readFile, rm, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isStorableTier, storeVerified, recallExact, buildMemoryRecord } from "./memory.js";

let dir: string | undefined;
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

function tempPath(name = "knowledge.jsonl") {
  dir = join(tmpdir(), `dispatch-mem-${Math.random().toString(36).slice(2)}`);
  return join(dir, name);
}

describe("isStorableTier", () => {
  it("only permits tier 2 (public content) to be stored", () => {
    expect(isStorableTier(0)).toBe(false);
    expect(isStorableTier(1)).toBe(false);
    expect(isStorableTier(2)).toBe(true);
  });
});

describe("storeVerified / recallExact", () => {
  it("stores and recalls an exact tier-2 match (newest wins)", async () => {
    const path = tempPath();
    await storeVerified(path, "what is a tier list?", 2, "first answer", "delegate-free");
    await storeVerified(path, "what is a tier list?", 2, "newer answer", "claude");

    const rec = await recallExact(path, "what is a tier list?", 2);
    expect(rec).not.toBeNull();
    expect(rec!.output).toBe("newer answer");
    expect(rec!.taskHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("never stores tier 0 or tier 1 content", async () => {
    const path = tempPath();
    await storeVerified(path, "my secret key abc", 0, "secret", "delegate-free");
    await storeVerified(path, "my infra config", 1, "private", "claude");

    const raw = await readFile(path, "utf-8").catch(() => "");
    expect(raw.trim()).toBe("");
    // Recall also refuses to serve private tiers.
    expect(await recallExact(path, "my secret key abc", 0)).toBeNull();
    expect(await recallExact(path, "my infra config", 1)).toBeNull();
  });

  it("does not store empty verified output", async () => {
    const path = tempPath();
    await storeVerified(path, "task", 2, "   ", "delegate-free");
    const raw = await readFile(path, "utf-8").catch(() => "");
    expect(raw.trim()).toBe("");
  });

  it("returns null when the store does not exist or has no match", async () => {
    const path = tempPath();
    expect(await recallExact(path, "anything", 2)).toBeNull();
    await storeVerified(path, "one thing", 2, "answer", "claude");
    expect(await recallExact(path, "different thing", 2)).toBeNull();
  });

  it("skips malformed lines and still finds valid records", async () => {
    const path = tempPath();
    await storeVerified(path, "good", 2, "answer", "claude");
    dir = undefined;
    const { appendFile } = await import("node:fs/promises");
    await appendFile(path, "not json\n", "utf-8");

    const rec = await recallExact(path, "good", 2);
    expect(rec).not.toBeNull();
    expect(rec!.output).toBe("answer");
  });

  it("buildMemoryRecord captures the expected fields", () => {
    const rec = buildMemoryRecord("task text", 2, "output", "delegate-free");
    expect(rec.kind).toBe("knowledge");
    expect(rec.tier).toBe(2);
    expect(rec.task).toBe("task text");
    expect(rec.taskHash).toMatch(/^[a-f0-9]{64}$/);
    expect(rec.storedAt).toBeTruthy();
  });
});
