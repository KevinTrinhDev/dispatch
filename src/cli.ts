#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs, ArgsError } from "./args.js";
import { runCascade, type AdapterRegistry } from "./cascade.js";
import { buildAuditRecord, appendAuditRecord } from "./audit.js";
import { scanForSecrets } from "./secretScan.js";
import { delegateFreeAdapter, delegateCheapAdapter, codexAdapter, claudeAdapter } from "./adapters/shell.js";
import { createGazeAdapter } from "./adapters/gaze.js";

const DEFAULT_AUDIT_LOG_PATH = join(homedir(), ".dispatch", "audit.jsonl");

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

export async function main(
  argv: string[],
  stdout: (s: string) => void,
  stderr: (s: string) => void,
  deps: MainDeps = {}
): Promise<number> {
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

  const { tier, task, explain } = parsed;

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

  const outcome = await runCascade(task, tier, adapters);

  const record = buildAuditRecord(task, tier, outcome);
  await appendAuditRecord(deps.auditLogPath ?? DEFAULT_AUDIT_LOG_PATH, record);

  if (explain) {
    stdout(`Routing trace (tier ${tier}):\n`);
    for (const attempt of outcome.attempts) {
      const verifiedNote = attempt.result.status === "ok" ? `, verified=${attempt.verified}` : "";
      stdout(`  - ${attempt.provider}: ${attempt.result.status}${verifiedNote}\n`);
    }
    stdout(`Final: ${outcome.finalStatus} via ${outcome.finalProvider ?? "none"}\n\n`);
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
