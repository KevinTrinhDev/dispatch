# Dispatch Task Decomposition Implementation Plan

**Goal:** Add `--decompose` to `dispatch run` so a task given at one explicit
tier is split into self-contained subtasks (produced by an eligible provider
CLI through the existing cascade, with JSON verification), each subtask routed
independently at the same tier, and the answers composed into one final output.

**Spec:** `docs/superpowers/specs/2026-09-05-dispatch-decomposition-spec.md`
Baseline v1 spec: `2026-09-05-dispatch-router-design.md`

**Tech:** TypeScript, vitest. Reuses `execa`, no new deps.

## Global constraints (inherit v1, plus)

- `--tier` required, never inferred. Subtasks inherit the parent tier; no
  re-tiering, no subtask-level inference.
- Decomposer step runs through the existing cascade at the parent tier with a
  JSON verifier. No new "internal agent loop".
- If the decomposer cannot produce a valid subtask plan, fall back to a normal
  single cascade on the whole task. Never drop or half-run the task.
- Subtasks execute sequentially.
- Audit redaction applies per subtask (≤40-char preview + SHA-256 for tier 0/1).
- All subprocess execution stays argv-array via `execa` (no shell strings).

---

## Task 1: Pluggable verifier in `runCascade`

`src/cascade.ts`: add a `Verifier` type (`(output: string) =>
VerificationResult`) and an optional trailing `verify` parameter defaulting to
`verifyOutput`. Replace the internal `verifyOutput(result.output)` call with
`verify(result.output)`. Backward compatible — no existing callers change.

Edit `src/cascade.test.ts` / add cases: passing a custom verifier changes
acceptance (e.g. `verifyJsonOutput` accepts JSON that plain verify also accepts,
and a verifier that always returns false escalates past an otherwise-"ok"
provider). [ ] 

## Task 2: Types

`src/types.ts`: add

```ts
export interface DecomposedSubtask { subtask: string; outcome: CascadeOutcome }
export type DecomposedStatus = CascadeOutcome["finalStatus"]; // reuse union
export interface DecompositionOutcome {
  decomposed: boolean;
  subtasks: DecomposedSubtask[];
  finalOutput: string;
  finalStatus: CascadeOutcome["finalStatus"];
}
```

[ ]

## Task 3: Decomposition module

New `src/decompose.ts`:
- `DECOMPOSE_INSTRUCTION` string (JSON-array-of-strings prompt; 2–6 subtasks).
- Constants `MIN_SUBTASKS = 2`, `MAX_SUBTASKS` safety cap (see code; bounds
  provider calls, e.g. 20).
- `parseSubtaskPlan(output: string): string[] | null` — `JSON.parse`, validate
  array + length bounds + non-empty-string elements; else `null`.
- `decomposeTask(task, tier, adapters, timeoutMs?): Promise<string[] | null>` —
  run `runCascade(INSTRUCTION + task, tier, adapters, timeoutMs,
  verifyJsonOutput)`; on a usable verified plan return it, else `null`.
- `runDecomposed(task, tier, adapters, timeoutMs?): Promise<DecompositionOutcome>`
  — call `decomposeTask`; if plan, run each subtask sequentially through
  `runCascade` at the parent tier; if no plan, fall back to a single
  `runCascade` on the whole task (`decomposed:false`). Compute composed
  `finalOutput` and aggregate `finalStatus` per spec §5.

Add `src/decompose.test.ts` covering spec §9 decomposition/fallback/tier/
status cases. [ ]

## Task 4: Args

`src/args.ts`: add `decompose: boolean` to `ParsedArgs`; parse `--decompose`
(default false). Update `USAGE` to show the optional flag. Extend
`src/args.test.ts`. [ ]

## Task 5: Audit

`src/audit.ts`: extract a shared tier-redaction helper (preview + hash used by
both record builders) and add `buildDecompositionSummaryRecord` returning a
summary record (parent preview/hash by tier, subtask/verified/failed counts,
aggregate status, total duration). Add tests that no tier-0/1 subtask text and
no parent full text appears in the log. [ ]

## Task 6: CLI wiring

`src/cli.ts`: after building adapters and scanning the parent task, branch on
`parsed.decompose`:
- decomposed: time the whole run; loop subtask outcomes appending one
  per-subtask audit record each (durations measured per subtask); append one
  summary record; print composed output; `--explain` prints the decomposition
  plan + per-subtask cascade trace + aggregate line.
- else: unchanged v1 path.
- Unverified/all-failed stderr warning and exit-code mapping for the aggregate
  outcome.

Extend `src/cli.test.ts`: decomposed happy path; fallback when decomposer is
unverifiable; `--decompose` requires `--tier`; off-path parity with v1. [ ]

## Task 7: Build + test green

`npm test` all pass; `npm run build` clean. [ ]

## Task 8: README/roadmap + commit

Update `README.md` (features, usage line with `--decompose`, roadmap checkbox)
and tick decomposition on the roadmap. Commit on `master` with a clear message.

[ ]

## Post-plan checklist (not a task)

- Confirm every `AdapterResult` path and aggregate status has a test.
- Recommended follow-up (not done here): run this spec through an independent
  security/architecture review mirroring v1's four-reviewer process before a
  release, given the decomposer becomes a new model-in-the-loop surface.
