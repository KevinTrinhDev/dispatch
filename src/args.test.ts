import { describe, expect, it } from "vitest";
import { parseArgs, ArgsError } from "./args.js";

describe("parseArgs", () => {
  it("parses a valid run command", () => {
    const result = parseArgs(["run", "--tier", "1", "summarize this file"]);
    expect(result).toEqual({
      command: "run",
      tier: 1,
      task: "summarize this file",
      explain: false,
      decompose: false,
    });
  });

  it("parses the --decompose flag", () => {
    const result = parseArgs(["run", "--tier", "2", "--decompose", "do the thing"]);
    expect(result.decompose).toBe(true);
    expect(result.tier).toBe(2);
  });

  it("parses the --explain flag", () => {
    const result = parseArgs(["run", "--tier", "0", "--explain", "do the thing"]);
    expect(result.explain).toBe(true);
    expect(result.tier).toBe(0);
  });

  it("joins multiple positional words into one task string", () => {
    const result = parseArgs(["run", "--tier", "2", "do", "the", "thing"]);
    expect(result.task).toBe("do the thing");
  });

  it("throws ArgsError when --tier is missing", () => {
    expect(() => parseArgs(["run", "do the thing"])).toThrow(ArgsError);
  });

  it("throws ArgsError when --tier value is invalid", () => {
    expect(() => parseArgs(["run", "--tier", "5", "do the thing"])).toThrow(ArgsError);
  });

  it("throws ArgsError when task text is missing", () => {
    expect(() => parseArgs(["run", "--tier", "1"])).toThrow(ArgsError);
  });

  it("throws ArgsError on an unknown command", () => {
    expect(() => parseArgs(["plan", "--tier", "1", "x"])).toThrow(ArgsError);
  });
});
