import type { AdapterResult, ProviderAdapter, Tier } from "../types.js";

export class GazeTierBlockedError extends Error {
  constructor() {
    super("gaze adapter cannot be used for Tier 0 tasks");
  }
}

export function createGazeAdapter(tier: Tier): ProviderAdapter {
  return {
    name: "gaze",
    async run(_task: string, _opts: { timeoutMs: number }): Promise<AdapterResult> {
      if (tier === 0) {
        throw new GazeTierBlockedError();
      }
      // gaze has no one-shot "send a prompt to a browser chat" subcommand
      // (verified against `gaze --help`: real verbs are goto/text/html/map/
      // shot/click/fill/press/scroll/eval/download/upload/scrape/links/
      // table/console/network/batch). Relaying a task to a browser-based LLM
      // chat needs a multi-step flow (goto, fill, press, wait, scrape) that
      // doesn't fit this adapter's one-shot-command shape, and is out of
      // scope for v1. Return an honest error instead of running a
      // nonexistent subcommand so the cascade escalates past this stub.
      return {
        status: "error",
        message:
          "gaze adapter is not yet implemented in v1 — sending a prompt to a browser-based chat requires a multi-step flow (goto/fill/press/scrape) not yet built; this provider is currently a no-op stub",
      };
    },
  };
}
