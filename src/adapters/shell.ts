import { runCommand } from "./exec.js";
import type { AdapterResult, ProviderAdapter, ProviderName } from "../types.js";

function makeShellAdapter(
  name: ProviderName,
  command: string,
  buildArgs: (task: string) => string[]
): ProviderAdapter {
  return {
    name,
    async run(task: string, opts: { timeoutMs: number }): Promise<AdapterResult> {
      return runCommand(command, buildArgs(task), opts.timeoutMs);
    },
  };
}

export const delegateFreeAdapter = makeShellAdapter("delegate-free", "delegate", (task) => ["free", task]);
export const delegateCheapAdapter = makeShellAdapter("delegate-cheap", "delegate", (task) => ["cheap", task]);
export const codexAdapter = makeShellAdapter("codex", "delegate", (task) => ["gpt", task]);
export const claudeAdapter = makeShellAdapter("claude", "claude", (task) => ["-p", task]);
