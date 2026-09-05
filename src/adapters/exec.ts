import { execa } from "execa";
import type { AdapterResult } from "../types.js";

const FORCE_KILL_AFTER_MS = 5000;

export async function runCommand(
  command: string,
  args: string[],
  timeoutMs: number
): Promise<AdapterResult> {
  try {
    const result = await execa(command, args, {
      timeout: timeoutMs,
      killSignal: "SIGTERM",
      forceKillAfterDelay: FORCE_KILL_AFTER_MS,
      reject: false,
    });

    if (result.timedOut) {
      return { status: "timeout" };
    }
    if (result.exitCode !== 0) {
      return {
        status: "partial",
        output: result.stdout ?? "",
        reason: `exited with code ${result.exitCode}`,
      };
    }
    return { status: "ok", output: result.stdout ?? "", exitCode: result.exitCode ?? 0 };
  } catch (err) {
    return { status: "error", message: err instanceof Error ? err.message : String(err) };
  }
}
