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

Concretely this needs a small, backward-compatible change to the cascade:
`runCascade` gains an optional `verify` argument (defaulting to today's
`verifyOutput`). The decomposition step calls `runCascade(metaTask, tier,
adapters, timeoutMs, verifySubtaskPlan)`. This reuses, for free:

- provider selection by tier (cheapest eligible first — local model first),
- empty/refusal/error escalation to the next eligible provider,
- a **shape verifier** (`verifySubtaskPlan`) that only accepts output which is a
  usable JSON subtask *array*. This is intentionally stronger than
  `verifyJsonOutput`: a provider returning valid-but-wrong-shape JSON (e.g.
  `{"plan": [...]}`) is treated as a failed attempt and the run escalates to the
  next eligible provider, rather than halting the cascade on unhelpful JSON.

If the decomposer returns an array that does not validate (see 4.2), or if no
eligible provider returns a usable plan, **decomposition is abandoned** and
the whole task falls back to a normal single-cascade run. The caller's task is
never silently dropped and never half-decomposed.

### 4.2 Subtask-plan validation

The returned JSON must be a non-empty JSON array. Validation rules:

- is a JSON array of strings;
- length between `2` and `DECOMP_MAX_SUBTASKS` (a small safety cap, see code —
  bounds the number of subtasks one invocation can trigger);
- every element is a string whose trimmed value is non-empty.

If `1` is returned, that is treated as "no real decomposition" and falls back
(equivalent to refusing to split). Anything else invalid also falls back.

In addition, the whole decomposed run shares one **attempt budget**
(`MAX_TOTAL_ATTEMPTS`, default 40) threaded through the decomposer cascade and
every subtask cascade, so a single `--decompose` invocation cannot trigger an
unbounded number of provider launches regardless of how many cascading failures
occur. `runCascade` consumes a budget unit only for providers actually present
in the registry, and stops launching once the budget is exhausted.

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

So a decomposed run appends, in order:

1. one audit record for the **decomposer cascade** (role `"decomposer"`), so the
   provider run(s) that produced the plan are always accounted for — including
   on the fallback path where the decomposer attempt fails and the plan is
   abandoned, its real subprocess invocations are still logged;
2. one per-subtask audit record for every subtask's cascade (role `"subtask"`,
   `buildAuditRecord` + `appendAuditRecord`, unchanged redaction);
3. one aggregate **decomposition summary** record capturing the parent task's
   redacted preview/hash, subtask count, verified/failed counts, aggregate
   status, and total wall-clock time.

Every audit record carries a `role` (`"run"` / `"decomposer"` / `"subtask"`) so
a consumer can tell which provider cascade a given record describes. This keeps
per-work proof (the audit trail for each provider run) and gives one record that
describes the decomposition as a unit.

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

## 10. Independent hardening review (revision 1)

This spec and the accompanying implementation were run through an independent
adversarial security/architecture review after the initial implementation, to
close the gap noted in §2 that it had not seen v1's four-reviewer process.
Verdict: **no Critical or High findings** — the tier invariant holds on every
path, execution is argv-array `execa` (no shell injection), and per-subtask
audit redaction is correct at the parent tier.

Resolved findings (all incorporated and covered by tests):

- **F1 (Medium) — decomposer cascade not audited.** The decomposer cascade is
  now returned by `planSubtasks`, exposed on the outcome, and appended as a
  `role:"decomposer"` audit record — so a failed decomposer attempt's real
  provider launches are never silently unlogged. (§6)
- **F2 (Medium) — no global resource budget.** `runDecomposed` now threads a
  shared `AttemptBudget` through the decomposer cascade and every subtask
  cascade, and stops launching once exhausted. Default
  `MAX_TOTAL_ATTEMPTS = 40` bounds total provider launches behind the
  20-subtask × ≤5-provider × timeout worst case. `runCascade` decrements the
  budget only for providers actually present in the registry. (§4)
- **F3 (Medium) — verifier weaker than validator.** The decomposer cascade now
  uses a shape verifier (`verifySubtaskPlan`) that only accepts output which is
  a *usable* JSON subtask array, so a provider returning valid-but-wrong-shape
  JSON (e.g. `{"plan": [...]}`) no longer halts the cascade — it escalates to
  the next eligible provider. (§4.1)

Deferred (documented, low risk, not blocking):

- F4 partial-failure UX: an `unverified` composed answer still prints empty
  `[subtask N]` delimiters around failed parts; aggregate status stays honest.
- F5 subtask content is not independently re-scanned for secret-shaped text
  before reaching cloud providers (the parent scan already covers it).
- F6 leading-`-` subtask text is passed as a positional argv (no shell
  injection; a provider may interpret it as a flag — model-controlled bytes).
- F7 a valid plan whose subtasks all fail returns `all-failed` rather than
  retrying the whole task (deliberate: avoids doubling cost after a clean
  decomposition failure).
- F8 cosmetic: `MAX_SUBTASKS=20` is wider than the prompt's "2–6" hint.

## 11. Revision history

- 2026-09-05 (rev 0): initial spec.
- 2026-09-05 (rev 1): independent hardening review; added §10 and integrated
  F1/F2/F3 fixes into §4/§6.
