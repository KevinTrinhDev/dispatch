import type { Tier } from "./types.js";

export interface ParsedArgs {
  command: "run";
  tier: Tier;
  task: string;
  explain: boolean;
}

export class ArgsError extends Error {}

const USAGE = 'Usage: dispatch run --tier <0|1|2> "<task>"';

export function parseArgs(argv: string[]): ParsedArgs {
  if (argv[0] !== "run") {
    throw new ArgsError(`Unknown command "${argv[0] ?? ""}". ${USAGE}`);
  }

  let tier: Tier | null = null;
  let explain = false;
  const positional: string[] = [];

  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--tier") {
      i++;
      const value = argv[i];
      if (value !== "0" && value !== "1" && value !== "2") {
        throw new ArgsError(`--tier must be 0, 1, or 2, got "${value ?? ""}". ${USAGE}`);
      }
      tier = Number(value) as Tier;
    } else if (arg === "--explain") {
      explain = true;
    } else {
      positional.push(arg);
    }
  }

  if (tier === null) {
    throw new ArgsError(`--tier is required. ${USAGE}`);
  }
  if (positional.length === 0) {
    throw new ArgsError(`Task description is required. ${USAGE}`);
  }

  return { command: "run", tier, task: positional.join(" "), explain };
}
