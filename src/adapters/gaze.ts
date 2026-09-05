import { runCommand } from "./exec.js";
import type { AdapterResult, ProviderAdapter, Tier } from "../types.js";

export class GazeTierBlockedError extends Error {
  constructor() {
    super("gaze adapter cannot be used for Tier 0 tasks");
  }
}

export function createGazeAdapter(tier: Tier): ProviderAdapter {
  return {
    name: "gaze",
    async run(task: string, opts: { timeoutMs: number }): Promise<AdapterResult> {
      if (tier === 0) {
        throw new GazeTierBlockedError();
      }
      return runCommand("gaze", ["prompt", task], opts.timeoutMs);
    },
  };
}
