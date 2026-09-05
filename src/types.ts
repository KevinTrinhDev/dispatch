export type Tier = 0 | 1 | 2;

export type ProviderName =
  | "delegate-free"
  | "delegate-cheap"
  | "codex"
  | "claude"
  | "gaze";

export type AdapterResult =
  | { status: "ok"; output: string; exitCode: number }
  | { status: "partial"; output: string; reason: string }
  | { status: "timeout" }
  | { status: "error"; message: string };

export interface ProviderAdapter {
  name: ProviderName;
  run(task: string, opts: { timeoutMs: number }): Promise<AdapterResult>;
}

export interface CascadeAttempt {
  provider: ProviderName;
  result: AdapterResult;
  verified: boolean;
  verificationReason?: string;
}

export interface CascadeOutcome {
  tier: Tier;
  attempts: CascadeAttempt[];
  finalOutput: string;
  finalStatus: "verified" | "unverified" | "all-failed";
  finalProvider: ProviderName | null;
}

export interface DecomposedSubtask {
  subtask: string;
  outcome: CascadeOutcome;
  durationMs: number;
}

export interface DecompositionOutcome {
  decomposed: boolean;
  /** The cascade that attempted to produce the subtask plan (audited so every
   * provider run — including a failed decomposer attempt — is accounted for). */
  decomposerOutcome: CascadeOutcome;
  decomposerDurationMs: number;
  subtasks: DecomposedSubtask[];
  finalOutput: string;
  finalStatus: CascadeOutcome["finalStatus"];
}
