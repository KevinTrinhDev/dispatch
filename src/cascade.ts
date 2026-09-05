import type {
  AdapterResult,
  CascadeAttempt,
  CascadeOutcome,
  ProviderAdapter,
  ProviderName,
  Tier,
} from "./types.js";
import { eligibleProviders } from "./rules.js";
import { verifyOutput } from "./verify.js";

export type AdapterRegistry = Partial<Record<ProviderName, ProviderAdapter>>;

const DEFAULT_TIMEOUT_MS = 120_000;

export async function runCascade(
  task: string,
  tier: Tier,
  adapters: AdapterRegistry,
  timeoutMs: number = DEFAULT_TIMEOUT_MS
): Promise<CascadeOutcome> {
  const order = eligibleProviders(tier);
  const attempts: CascadeAttempt[] = [];

  for (const providerName of order) {
    const adapter = adapters[providerName];
    if (!adapter) continue;

    let result: AdapterResult;
    try {
      result = await adapter.run(task, { timeoutMs });
    } catch (err) {
      result = { status: "error", message: err instanceof Error ? err.message : String(err) };
    }

    if (result.status === "ok") {
      const verification = verifyOutput(result.output);
      attempts.push({
        provider: providerName,
        result,
        verified: verification.verified,
        verificationReason: verification.reason,
      });
      if (verification.verified) {
        return {
          tier,
          attempts,
          finalOutput: result.output,
          finalStatus: "verified",
          finalProvider: providerName,
        };
      }
      continue;
    }

    attempts.push({ provider: providerName, result, verified: false });
  }

  const lastUsable = [...attempts].reverse().find(
    (a) => a.result.status === "ok" || a.result.status === "partial"
  );
  const finalOutput =
    lastUsable && (lastUsable.result.status === "ok" || lastUsable.result.status === "partial")
      ? lastUsable.result.output
      : "";

  return {
    tier,
    attempts,
    finalOutput,
    finalStatus: attempts.length === 0 ? "all-failed" : lastUsable ? "unverified" : "all-failed",
    finalProvider: lastUsable?.provider ?? null,
  };
}
