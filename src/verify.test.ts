import { describe, expect, it } from "vitest";
import { verifyOutput, verifyJsonOutput } from "./verify.js";

describe("verifyOutput", () => {
  it("fails on empty output", () => {
    expect(verifyOutput("").verified).toBe(false);
    expect(verifyOutput("   ").verified).toBe(false);
  });

  it("fails on a known refusal phrase", () => {
    const result = verifyOutput("I'm sorry, I cannot help with that request.");
    expect(result.verified).toBe(false);
    expect(result.reason).toContain("refusal phrase");
  });

  it("passes on ordinary non-empty output", () => {
    expect(verifyOutput("Here is the summary you asked for.").verified).toBe(true);
  });
});

describe("verifyJsonOutput", () => {
  it("fails on empty output before even checking JSON", () => {
    expect(verifyJsonOutput("").verified).toBe(false);
  });

  it("fails on non-JSON output", () => {
    expect(verifyJsonOutput("this is not json").verified).toBe(false);
  });

  it("passes on valid JSON output", () => {
    expect(verifyJsonOutput('{"ok": true}').verified).toBe(true);
  });
});
