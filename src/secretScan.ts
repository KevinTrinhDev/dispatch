export interface SecretScanResult {
  suspicious: boolean;
  matches: string[];
}

const SECRET_PATTERNS: { label: string; pattern: RegExp }[] = [
  { label: "PEM private key header", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { label: "AWS access key", pattern: /AKIA[0-9A-Z]{16}/ },
  { label: "GitHub token", pattern: /gh[pousr]_[A-Za-z0-9]{36,}/ },
  { label: "generic high-entropy token (40+ chars)", pattern: /\b[A-Za-z0-9+/=_-]{40,}\b/ },
];

export function scanForSecrets(text: string): SecretScanResult {
  const matches: string[] = [];
  for (const { label, pattern } of SECRET_PATTERNS) {
    if (pattern.test(text)) {
      matches.push(label);
    }
  }
  return { suspicious: matches.length > 0, matches };
}
