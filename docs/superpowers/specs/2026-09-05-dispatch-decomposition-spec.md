# Dispatch Task Decomposition — Design Spec

Status: draft for implementation (this is a follow-on spec; v1 spec at
`2026-09-05-dispatch-router-design.md` remains the baseline for everything not
overridden here)
Date: 2026-09-05
Repo: `KevinTrinhDev/dispatch`
License: Apache-2.0

## 1. Problem and scope

v1 routes one task at a time: given a task and an explicit tier, it runs the
cheapest eligible provider, verifies the output, and escalates through the
cascade until it gets a verified answer (or returns the last usable output as
`unverified`).

That single-shot shape is fine for a focused task, but many real requests are
compound ("write a script, then a README for it, then a test suite") and get
worse answers from one provider call than from several focused ones. v1
explicitly deferred this to a future spec (v1 spec §1 and §11).

This spec adds **task decomposition**: splitting one task, given at a single
explicit tier, into ordered subtasks that are each routed independently through
the existing cascade-with-verification, then composing the subtask answers into
one final answer for the caller.

**Out of scope for this spec** (each is a separate future spec, unchanged from
v1 §11): running subtasks concurrently or spawning long-lived subagents, shared
memory/knowledge store, security hardening beyond the tier gate, desktop UI,
and a declarative policy engine.

## 2. The tier invariant (hardest constraint)

The v1 security model rests on one rule: **tier is explicit, human-supplied,
and never inferred from task content** (v1 spec §7). Task decomposition must
not quietly break that.

Decomposition splits **work**, not **sensitivity**. Therefore:

- Every subtask inherits the **parent run's explicit tier**. Dispatch never
  assigns a subtask its own tier, never lowers one, and never sends any
  subtask to a provider the parent's tier forbids.
- Concretely: a `--tier 0` decomposition may only use local providers for the
  decomposer step *and* for every subtask; a `--tier 2` decomposition stays at
  tier 2. The rule table (`rules.ts`) is the single source of provider
  eligibility and is applied unchanged to every sub-run.
- The **decomposer step** (the call that produces the subtask list) is itself
  just another run at the parent tier, so its input (which contains the parent
  task text) is subject to the exact same tier redaction when it is later
  audited.

**[Design note — not externally reviewed.]** A design that let each subtask be
re-tiered independently (e.g. "this subtask looks public, route it to a cloud
provider") would reintroduce exactly the auto-classification failure mode the
v1 spec §4 and §7 argue against, and would turn the decomposer into a new
tier-inference oracle. Inheriting the parent tier is the conservative choice
and is what makes the feature safe to ship inside the existing model. This
spec has **not** been through the independent four-reviewer process v1 used; a
review pass is a recommended follow-up (see plan post-checklist).

## 3. CLI surface

Extend the existing `run` command with one optional flag; no new verb.

```
dispatch run --tier <0|1|2> [--decompose] "<task>"
```

- `--decompose` is optional. When absent, behavior is byte-for-byte v1
  (`runCascade` on the whole task).
- `--tier` stays required and never inferred. When `--decompose` is set but
  `--tier` is omitted, the same hard error fires as today.
- `--explain` continues to work; for a decomposed run it prints the
  decomposition plan and a per-subtask cascade trace.
- The exit code is `0` when the composed answer is `verified`, `1` when it is
  `all-failed`. A partially-unverified composed answer returns `0` but prints
  the same stderr warning v1 prints for unverified output.

A separate `decompose` verb was considered and rejected: it would duplicate the
tier/scan/audit plumbing for no user benefit, and decomposition still produces
one composed answer, so it belongs on `run`.

## 4. How decomposition happens

Dispatch is a router, not an agent: it has no internal reasoning loop and must
not "reimplement" one (v1 spec §2/README comparison). So the split is produced
the same way every answer is produced here — **by an eligible provider CLI,
through the existing cascade**.

### 4.1 The decomposer step

Dispatch builds a meta-task: a short, fixed instruction that says *"split the
following task into 2–6 self-contained subtasks and return ONLY a JSON array of
strings"*, followed by the parent task text. That meta-task is then run through
the ordinary cascade machinery, **at the parent tier**, but with a JSON output
verifier instead of the plain-output verifier.

Concretely this needs one small, backward-compatible change to the cascade:
`runCascade` gains an optional `verify` argument (defaulting to today's
`verifyOutput`). The decomposition step calls `runCascade(metaTask, tier,
adapters, timeoutMs, verifyJsonOutput)`. This reuses, for free:

- provider selection by tier (cheapest eligible first — local model first),
- empty/refusal/error escalation to the next eligible provider,
- the JSON parsing check already present as `verifyJsonOutput` in `verify.ts`.

If the decomposer returns an array that does not validate (see 4.2), or if no
eligible provider returns verifiable JSON, **decomposition is abandoned** and
the whole task falls back to a normal single-cascade run. The caller's task is
never silently dropped and never half-decomposed.

### 4.2 Subtask-plan validation

The returned JSON must be a non-empty JSON array. Validation rules:

- parse as JSON (already enforced by `verifyJsonOutput`);
- is an array;
- length between `2` and `DECOMP_MAX_SUBTASKS` (a small safety cap, see code —
  bounds the number of provider calls one invocation can trigger);
- every element is a string whose trimmed value is non-empty.

If `1` is returned, that is treated as "no real decomposition" and falls back
(equivalent to refusing to split). Anything else invalid also falls back.

### 4.3 Executing subtasks

Each validated subtask string is then run **sequentially** through the full
`runCascade` at the parent tier. Sequential (not concurrent) is a deliberate v1
choice:

- audit ordering is deterministic (one record per subtask, in order);
- each provider call can have side effects (file writes, commits — v1 spec §5),
  so concurrent side-effecting runs are unsafe without a transaction story;
- the timeout model stays simple: each sub-run honors the same per-call
  timeout. A single global time budget is deferred to the future "concurrent
  subagent spawning" spec.

Each subtask independently cascades/escalates across its tier's eligible
providers exactly as v1 does for a top-level task.

## 5. Composition

The composed final output is a plain-text block with a clear, greppable
delimiter per subtask:

```
[subtask 1]
<verified/usable output for subtask 1>

[subtask 2]
<output for subtask 2>
...
```

No cross-subtask rewriting or "merging" is performed in v1 (that would require
another model call and another verification step, out of scope). The composed
result is `verified` only if **every** subtask's cascade ended `verified`.
Aggregate status semantics mirror the single-run cascade:

- all subtasks `verified` → composed `finalStatus = "verified"`;
- at least one subtask produced a usable (ok/partial, non-empty) output, but
  not all verified → `"unverified"`;
- no subtask produced any usable output → `"all-failed"`.

The caller reads one composed answer; `--explain` reveals the per-subtask
detail.

## 6. Audit implications

The audit purpose (v1 spec §6: "a green check must prove work happened") still
applies, and the redaction rule must apply to **each subtask independently**,
because a subtask string is a separate data payload: for a tier 0/1 run the
log must never contain a subtask's full text, only its ≤40-char preview and
SHA-256 hash.

So a decomposed run appends:

1. one normal per-subtask audit record for every subtask's cascade
   (`buildAuditRecord` + `appendAuditRecord`, unchanged redaction), plus
2. one aggregate **decomposition summary** record capturing the parent task's
   redacted preview/hash, subtask count, verified/failed counts, aggregate
   status, and total wall-clock time.

This keeps per-work proof (the audit trail for each provider run) and gives one
record that describes the decomposition as a unit.

## 7. Verification / refusals

The composed block intentionally does not run the whole composed text through
`verifyOutput` — individual subtasks were each verified, and concatenating
verified parts does not need a second global check. Aggregate status (section
5) is computed from the per-subtask statuses.

## 8. Files

- New `src/decompose.ts` — instruction constant, validation, subtask-plan
  step, sequential executor, composition, aggregate status.
- New `src/decompose.test.ts`.
- Edit `src/cascade.ts` — optional `verify` argument (default `verifyOutput`).
- Edit `src/types.ts` — decomposed outcome types.
- Edit `src/args.ts` — parse `--decompose`.
- Edit `src/cli.ts` — branch to decomposition, audit both subtask and summary
  records, `--explain` per-subtask trace.
- Edit `src/audit.ts` — shared tier-redaction helper + decomposition summary
  record builder.
- Tests for args/cascade/cli extended; README + roadmap updated.

## 9. Testing

- Decomposition cascade: valid plan splits into N subtasks, each routed at the
  parent tier.
- Invalid/refusal/single-item/non-array/empty-array decomposer responses → fall
  back to a single normal cascade; the caller still gets an answer.
- Tier invariant: a tier-0 decomposition never routes a subtask to a non-local
  provider (verified by asserting only tier-0-eligible adapters are invoked),
  including the decomposer step.
- Aggregate status mapping for verified/unverified/all-failed across subtasks.
- Audit: no tier-0/1 subtask full text appears in the log; summary record
  fields correct.
- `--decompose` without `--tier` still errors; `--decompose` off-path behaves
  exactly like v1.
