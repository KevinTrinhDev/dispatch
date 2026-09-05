export interface VerificationResult {
  verified: boolean;
  reason: string;
}

const REFUSAL_PHRASES = [
  "i cannot help with that",
  "i can't assist with that",
  "as an ai language model",
  "i'm not able to",
];

export function verifyOutput(output: string): VerificationResult {
  const trimmed = output.trim();
  if (trimmed.length === 0) {
    return { verified: false, reason: "empty output" };
  }
  const lower = trimmed.toLowerCase();
  for (const phrase of REFUSAL_PHRASES) {
    if (lower.includes(phrase)) {
      return { verified: false, reason: `contains refusal phrase: "${phrase}"` };
    }
  }
  return { verified: true, reason: "non-empty, no refusal phrases detected" };
}

export function verifyJsonOutput(output: string): VerificationResult {
  const base = verifyOutput(output);
  if (!base.verified) return base;
  try {
    JSON.parse(output);
    return { verified: true, reason: "valid JSON" };
  } catch {
    return { verified: false, reason: "output did not parse as JSON" };
  }
}
