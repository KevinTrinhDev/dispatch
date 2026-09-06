# Dispatch Shared Memory — Design Spec

Status: implemented (rev 0)
Date: 2026-09-05
Repo: `KevinTrinhDev/dispatch`
License: Apache-2.0
Base specs: `2026-09-05-dispatch-router-design.md` (v1),
`2026-09-05-dispatch-decomposition-spec.md`

## 1. Problem and scope

Every `dispatch run` is stateless: even a task it answered yesterday is fully
re-run, paying provider cost/time again. The roadmap item "shared memory /
knowledge store across runs" asks for a way for the router to remember verified
results and reuse them.

This spec adds an opt-in, tier-safe knowledge store. It does **not** add an
agent loop or retrieval — Dispatch stays a thin router. Memory here means: a
durable, append-only store of **verified, already-public results** that a later
run can recall by exact task text, so identical public work is not repeated.

## 2. Tier invariant (the hard constraint, again)

v1's rule is that tier is explicit and never inferred, and the audit log never
holds private content in full. A knowledge store that persisted results would be
a second plaintext copy of whatever a run saw — reintroducing the leak the audit
redaction exists to prevent (v1 spec §6).

Therefore the store **only ever persists tier 2 content** (already public):

- storing a result for tier 0 or tier 1 is a **no-op** (nothing written);
- recalling for tier 0 or tier 1 always returns nothing (runs fresh);
- `--recall` on a private tier therefore silently behaves exactly like a normal
  run — correct, because a private run's content is never cached anywhere.

This is enforced in `memory.ts` (`isStorableTier`), mirroring the audit
redaction split, not merely documented.

## 3. CLI surface

`--recall` is a new optional flag on `run`:

```
dispatch run --tier <0|1|2> [--recall] "<task>"
```

- **Default off.** Without `--recall`, behavior is byte-for-byte unchanged: no
  store reads and no store writes.
- With `--recall` on a single (non-decomposed) run:
  1. If the store has a prior verified tier-2 result for the exact task text,
     Dispatch returns it without invoking any provider (a note goes to stderr,
     and a `kind:"recall"` audit record is appended). Exit 0.
  2. Otherwise it runs normally, and if the result is `verified`, stores it for
     later reuse.
- `--recall` with `--decompose` is ignored (a note is printed): memory recall is
  a single-run feature in this version.

## 4. Storage

- File: `~/.dispatch/knowledge.jsonl` (sibling of the audit log), append-only
  JSON lines, same bounded-line + concurrent-safe write approach as the audit
  log. One line per stored verified tier-2 result:
  `{ kind: "knowledge", taskHash, tier: 2, task, output, finalProvider, storedAt }`.
- `taskHash` is the SHA-256 of the full task text (used as the recall key).
- Empty outputs are not stored.
- Recall scans newest→oldest and returns the most recent exact-match record;
  malformed lines are skipped, and a missing store returns nothing.

## 5. Recall is exact-match only

Recall matches on the full task text hash at tier 2. No fuzzy/semantic lookup in
this version — Dispatch does not classify or guess (consistent with §2 and v1's
no-inference stance). Fuzzy recall or context injection across related tasks is
deferred to a future spec.

## 6. Audit

A recall that satisfies a run appends a `kind:"recall"` audit record
(`taskPreview`/`taskHash` redacted as usual, plus a short `outputPreview` and the
original `storedAt`), so the audit trail still shows the run happened and was
served from memory rather than from a provider.

## 7. Files / tests

- New `src/memory.ts` + `src/memory.test.ts`.
- `src/audit.ts`: add `RecallRecord` + `buildRecallRecord`; widen the log union.
- `src/args.ts` / `src/cli.ts`: `--recall` parsing and single-run wiring.
- `src/cli.test.ts`: recall reuse, private-tier never cached, notes.
- README/help: document the flag and its tier-2-only behavior.

## 8. Testing

- Tier gate: tier 0/1 store is a no-op and recall returns null; tier 2 round-trips.
- Exact-match recall returns the newest result; no-match/missing store returns null.
- Malformed store lines are skipped.
- CLI: a verified tier-2 `--recall` run stores, then a repeat `--recall` run
  returns it without a second provider call; private tiers run fresh every time.
- Off-path parity: no `--recall` means no store I/O and no behavior change.

## 9. Scope boundaries

Not in this version (future specs): semantic/related-task recall, injecting
recalled context into provider prompts or subtasks, cross-subtask shared memory,
auto-pruning/TTL of the store, and any persistence of private-tier content.
