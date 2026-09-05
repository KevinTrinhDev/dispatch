import { describe, expect, it } from "vitest";
import { scanForSecrets } from "./secretScan.js";

describe("scanForSecrets", () => {
  it("flags a PEM private key header", () => {
    const result = scanForSecrets("-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQ...");
    expect(result.suspicious).toBe(true);
    expect(result.matches).toContain("PEM private key header");
  });

  it("flags an AWS access key pattern", () => {
    const result = scanForSecrets("here is my key AKIAIOSFODNN7EXAMPLE thanks");
    expect(result.suspicious).toBe(true);
    expect(result.matches).toContain("AWS access key");
  });

  it("flags a long high-entropy token", () => {
    const result = scanForSecrets("token: " + "ab12".repeat(10));
    expect(result.suspicious).toBe(true);
  });

  it("does not flag ordinary task text", () => {
    const result = scanForSecrets("please summarize this quarterly report for me");
    expect(result.suspicious).toBe(false);
    expect(result.matches).toEqual([]);
  });
});
