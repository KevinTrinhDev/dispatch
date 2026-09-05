import type { ProviderName, Tier } from "./types.js";

export const TIER_PROVIDER_ORDER: Record<Tier, ProviderName[]> = {
  0: ["delegate-free"],
  1: ["delegate-free", "claude", "codex", "gaze"],
  2: ["delegate-free", "claude", "codex", "delegate-cheap", "gaze"],
};

export function eligibleProviders(tier: Tier): ProviderName[] {
  return TIER_PROVIDER_ORDER[tier];
}
