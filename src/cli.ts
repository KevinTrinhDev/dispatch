#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { parseArgs, ArgsError } from "./args.js";
import { runCascade, type AdapterRegistry } from "./cascade.js";
import { runDecomposed } from "./decompose.js";
import {
  buildAuditRecord,
  buildDecompositionSummaryRecord,
  appendAuditRecord,
} from "./audit.js";
import { scanForSecrets } from "./secretScan.js";
import { delegateFreeAdapter, delegateCheapAdapter, codexAdapter, claudeAdapter } from "./adapters/shell.js";
import { createGazeAdapter } from "./adapters/gaze.js";
import type { DecompositionOutcome } from "./types.js";

const DEFAULT_AUDIT_LOG_PATH = join(homedir(), ".dispatch", "audit.jsonl");

const require = createRequire(import.meta.url);
const packageJson = require("../package.json") as { name: string; version: string };

export const HELP_TEXT = `dispatch — routes a task to the right AI provider CLI, by data tier.

Usage:
  dispatch run --tier <0|1|2> [--explain] [--decompose] "<task>"
  dispatch --help | -h
  dispatch --version | -v

Commands:
  run                  Route one task through the provider cascade and print the answer.
  --help, -h           Show this help.
  --version, -v        Print the dispatch version.

Options for "run":
  --tier <0|1|2>       Data sensitivity of the task. REQUIRED, never inferred:
                         0 = never leaves this machine (secrets, keys)
                         1 = your own accounts only (source, infra config)
                         2 = already public (open-source code, published docs)
  --decompose          Split the task into subtasks (each routed at the same
                       tier), then compose the answers.
  --explain            Print the routing trace: which providers ran and why.

Examples:
  dispatch run --tier 0 "what public key format is this?"
  dispatch run --tier 2 --decompose "write a script, its README, and a test"

Every run appends a tier-redacted record to ~/.dispatch/audit.jsonl.
`;

export interface MainDeps {
  adapters?: AdapterRegistry;
  auditLogPath?: string;
  isTTY?: boolean;
  confirm?: (question: string) => Promise<boolean>;
}

async function defaultConfirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`${question} [y/N] `);
    return answer.trim().toLowerCase() === "y";
  } finally {
    rl.close();
  }
}

function attemptLine(attempt: { provider: string; result: { status: string; output?: string; verified?: boolean; reason?: string; message?: string }; verified: boolean }): string {
  const verifiedNote = attempt.result.status === "ok" ? `, verified=${attempt.verified}` : "";
  let detail = "";
  if (attempt.result.status === "partial") {
    detail = ` (${attempt.result.reason ?? ""})`;
  } else if (attempt.result.status === "error") {
    detail = ` (${attempt.result.message ?? ""})`;
  }
  return `  - ${attempt.provider}: ${attempt.result.status}${verifiedNote}${detail}`;
}

function printExplain(outcome: DecompositionOutcome, stdout: (s: string) => void): void {
  stdout(`Decomposition trace (tier ${outcome.subtasks[0]?.outcome.tier ?? "?"}):\n`);
  if (outcome.decomposed) {
    stdout(`  Plan: ${outcome.subtasks.length} subtask(s)\n`);
  } else {
    stdout(`  No valid decomposition plan was produced; the whole task ran as one.\n`);
  }
  outcome.subtasks.forEach((subtask, i) => {
    stdout(`  Subtask ${i + 1}: ${subtask.outcome.finalStatus} via ${subtask.outcome.finalProvider ?? "none"}\n`);
    for (const attempt of subtask.outcome.attempts) {
      stdout(attemptLine(attempt));
    }
  });
  stdout(`Final: ${outcome.finalStatus} (${outcome.decomposed ? "decomposed" : "single run"})\n\n`);
}

export async function main(
  argv: string[],
  stdout: (s: string) => void,
  stderr: (s: string) => void,
  deps: MainDeps = {}
): Promise<number> {
  const first = argv[0] ?? "";
  if (first === "--help" || first === "-h" || first === "help") {
    stdout(HELP_TEXT);
    return 0;
  }
  if (first === "--version" || first === "-v") {
    stdout(`${packageJson.version}\n`);
    return 0;
  }

  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (err) {
    if (err instanceof ArgsError) {
      stderr(err.message + "\n");
      return 1;
    }
    throw err;
  }

  const { tier, task, explain, decompose } = parsed;

  const scan = scanForSecrets(task);
  if (scan.suspicious && tier > 0) {
    stderr(`Warning: task text matches secret-shaped patterns (${scan.matches.join(", ")}) but tier is ${tier}.\n`);
    const isTTY = deps.isTTY ?? Boolean(process.stdin.isTTY);
    if (isTTY) {
      const confirm = deps.confirm ?? defaultConfirm;
      const proceed = await confirm("Continue anyway?");
      if (!proceed) {
        stderr("Aborted. Tier was not changed automatically.\n");
        return 1;
      }
    } else {
      stderr("Non-interactive session: continuing automatically, warning logged.\n");
    }
  }

  const adapters: AdapterRegistry =
    deps.adapters ??
    {
      "delegate-free": delegateFreeAdapter,
      "delegate-cheap": delegateCheapAdapter,
      codex: codexAdapter,
      claude: claudeAdapter,
      gaze: createGazeAdapter(tier),
    };

  const auditLogPath = deps.auditLogPath ?? DEFAULT_AUDIT_LOG_PATH;

  // Decomposed path: split at the parent tier, route each subtask, compose.
  if (decompose) {
    const startedAt = Date.now();
    const outcome = await runDecomposed(task, tier, adapters);
    const totalDurationMs = Date.now() - startedAt;

    // Audit every provider cascade independently (redaction applies per task).
    // First the decomposer cascade, then one record per executed subtask.
    const decomposerRecord = buildAuditRecord(
      task,
      tier,
      outcome.decomposerOutcome,
      outcome.decomposerDurationMs,
      "decomposer"
    );
    await appendAuditRecord(auditLogPath, decomposerRecord);
    for (const subtask of outcome.subtasks) {
      const record = buildAuditRecord(subtask.subtask, tier, subtask.outcome, subtask.durationMs, "subtask");
      await appendAuditRecord(auditLogPath, record);
    }
    if (outcome.decomposed) {
      const summary = buildDecompositionSummaryRecord(
        task,
        tier,
        outcome.subtasks.map((s) => ({ status: s.outcome.finalStatus })),
        outcome.finalStatus,
        totalDurationMs
      );
      await appendAuditRecord(auditLogPath, summary);
    }

    if (explain) {
      printExplain(outcome, stdout);
    }

    if (outcome.finalStatus === "unverified") {
      stderr("Warning: one or more parts of the decomposed result could not be verified as real answers.\n");
    }

    stdout(outcome.finalOutput + "\n");
    return outcome.finalStatus === "all-failed" ? 1 : 0;
  }

  const startedAt = Date.now();
  const outcome = await runCascade(task, tier, adapters);
  const durationMs = Date.now() - startedAt;

  const record = buildAuditRecord(task, tier, outcome, durationMs);
  await appendAuditRecord(auditLogPath, record);

  if (explain) {
    stdout(`Routing trace (tier ${tier}):\n`);
    for (const attempt of outcome.attempts) {
      stdout(attemptLine(attempt));
    }
    stdout(`Final: ${outcome.finalStatus} via ${outcome.finalProvider ?? "none"}\n\n`);
  }

  if (outcome.finalStatus === "unverified") {
    stderr(`Warning: response from ${outcome.finalProvider} could not be verified as a real answer.\n`);
  }

  stdout(outcome.finalOutput + "\n");
  return outcome.finalStatus === "all-failed" ? 1 : 0;
}

async function run() {
  const exitCode = await main(
    process.argv.slice(2),
    (s) => process.stdout.write(s),
    (s) => process.stderr.write(s)
  );
  process.exit(exitCode);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run();
}
