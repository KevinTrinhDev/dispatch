# Dispatch v1 — Design Spec

Status: approved direction, pending final user sign-off on this document
Date: 2026-09-05
Repo: `KevinTrinhDev/dispatch` (personal project, separate from Atarla)
License: Apache-2.0
Runtime: TypeScript / Node, distributed as npm package `dispatch-cli`

## 1. Problem and scope

Kevin has several AI providers/tools already installed and working independently:
a local Ollama model (`delegate free`), an OpenRouter-backed cheap model
(`delegate cheap`), OpenAI's Codex CLI (`delegate gpt` / `codex`), Anthropic's
Claude Code CLI, and `gaze`, a browser-automation tool that drives a real
logged-in browser session (Gemini, ChatGPT-in-browser, Claude-in-browser).
Deciding which one should handle a given task is currently manual judgment,
governed by rules already written down in his global CLAUDE.md (a cost model
and a data-sensitivity tier system).

Dispatch's job: given a task description and an explicit data-sensitivity tier,
decide which installed provider should run it, hand off execution to that
provider's real CLI, and produce an auditable record of the decision.

**Explicitly out of scope for v1** (each is queued as its own future spec):
task decomposition into subtasks, spawning/managing multiple concurrent
subagents, a memory/knowledge-graph store, a security-hardening layer beyond
the tier gate described here, a desktop overlay UI.

This scope was deliberately narrowed from an initial much larger ask (a
do-everything harness with self-updating tool discovery, its own memory
engine, and a desktop mascot). That larger vision is not abandoned — it's
decomposed into a sequence of specs, of which this is the first.

## 2. External review

Before finalizing this design, four independent reviewers examined the initial
draft: a distributed-systems/architecture critic, a security researcher, an
LLM-routing academic-literature researcher, and an open-source ecosystem
scout. Their findings materially changed sections 4-6 below. Their full
reports are not reproduced here; the changes they drove are called out inline
as **[Review: ...]** notes so the reasoning stays traceable.

## 3. CLI surface

```
dispatch run --tier <0|1|2> "<task description>"
```

- `--tier` is **required**. Omitting it is an error, not a default. Tier is
  never inferred from task content — see section 6 for why, and for the one
  piece of defense-in-depth added anyway.
- `--explain` (optional flag): prints the routing decision and why it was
  made (which rule matched, or the cascade/verification trace) without
  suppressing normal execution. **[Review: architecture]**
- No other commands in v1. No daemon, no long-running process, no separate
  dry-run command — `--explain` covers that need without doubling the surface.

## 4. Routing logic: cascade with output verification

**Original plan (superseded):** static rule table first, falling back to a
cheap LLM call that *classifies the task* and picks a provider when no rule
matches.

**Revised plan, per the academic-literature review:** task-type classification
is a weak proxy for whether a cheap provider will actually succeed at a given
task, and this is a documented failure mode in the routing literature
(FrugalGPT, arXiv:2305.05176; AutoMix, arXiv:2310.12963) — both use
output-side verification instead of input-side classification, because
verifying an actual answer is more reliable than guessing in advance whether
one will be good. **[Review: academic]**

Revised flow for a task where the static rule table doesn't already force a
specific provider (e.g. tier forces "local only"):

1. Run the cheapest eligible provider for the task's tier first, regardless
   of task shape.
2. Run a cheap, local, deterministic verification check on the output:
   empty/near-empty response, known refusal phrases, or a task-specific
   validator when one is cheap to run (e.g. "does this output parse as JSON",
   "does this diff apply cleanly").
3. If verification fails, escalate to the next provider up the tier's
   allowed list and repeat. If the top of the allowed list still fails
   verification, return the last output with a clear "unverified" flag rather
   than silently presenting it as successful.

This replaces a second unreliable model in the decision path (the classifier)
with a deterministic check plus escalation — simpler to implement than the
original plan, not more complex, and grounded in published results rather
than intuition.

The static rule table still exists and still runs first — it encodes hard
constraints (tier eligibility, and any provider the user has explicitly
pinned for a task type) that must never be violated regardless of cascade
outcome. The cascade only operates within whatever set of providers the rules
say are eligible.

## 5. Provider adapters

One adapter per provider, each implementing:

```ts
interface ProviderAdapter {
  run(task: string, opts: { timeoutMs: number }): Promise<AdapterResult>
}

type AdapterResult =
  | { status: "ok"; output: string; exitCode: number }
  | { status: "partial"; output: string; reason: string }
  | { status: "timeout" }
  | { status: "error"; message: string }
```

**[Review: architecture]** The original interface (`{output, exitCode}`) was
too thin: exit code 0 doesn't reliably mean "good answer" across
heterogeneous CLIs, and there was no representation for a hung or
partially-completed process. The `partial`/`timeout` states are required, not
optional, so callers can't silently trust truncated output.

Implementation requirements for every adapter:
- Exec via `execa` with an **argv array**, never a shell string. **[Review:
  security — this closes a command-injection hole in the original draft,
  where task text was described as passed "as an argument" without
  specifying how; string interpolation into a shell command would have made
  any task text containing shell metacharacters a code-execution risk,
  especially since task text may originate from scraped/untrusted sources.]**
- Enforced wall-clock timeout per call, with SIGTERM followed by SIGKILL on
  expiry (standard escalation, not an immediate kill -9). **[Review:
  architecture]**
- No retry-on-timeout without an idempotency check for tasks that may have
  side effects (file writes, commits) — v1 keeps this simple by treating any
  non-`ok` result as terminal for that provider and moving to the next in the
  cascade, never silently re-running the same provider call.

**gaze adapter — special-cased**, per the security review:
- Hard-blocked from ever being selected for Tier 0 tasks, enforced in code,
  not just documentation, since gaze drives a live, logged-in session with
  email access.
- Dispatch never passes any flag to gaze that would bypass gaze's own
  interactive consent gate (e.g. never invokes gaze with an auto-approve
  flag). Consent-gating remains gaze's responsibility; Dispatch does not
  duplicate or route around it.
- gaze's returned page content is not written to Dispatch's audit log
  verbatim (see section 6) — same redaction rule as any other provider
  output.

## 6. Audit logging and the tier leak

**Original plan (flawed):** every run appends a JSONL record including the
full task text to a local log file.

**Problem found in review:** the router sees the complete, untiered task text
*before* any gating decision happens. Even a task correctly routed to stay
local (because it's Tier 0) still had its full secret/private content written
into a second, un-tiered, persistent plaintext copy — defeating the reason
the tier system exists. **[Review: security, rated highest-severity finding]**

**Revised logging rule:**
- Tier 2 tasks: log full task text (already public, no additional exposure).
- Tier 0 and Tier 1 tasks: log a truncated preview (first ~40 chars) plus a
  SHA-256 hash of the full text, never the full text itself. The hash lets
  you correlate a log entry back to a task later (e.g. by hashing a
  candidate string and comparing) without the log itself being a leak
  vector.
- Every record still includes: timestamp, tier, provider(s) tried in
  cascade order, which one succeeded, verification outcome, and total
  wall-clock time. This preserves the audit trail's purpose (Rule 4: a green
  check must prove work happened) without reintroducing the leak.
- Log writes are append-only and length-bounded per line so concurrent
  `dispatch run` invocations can't interleave/corrupt records (writes kept
  under `PIPE_BUF` via `execa`'s/Node's buffered write, one JSON line per
  write call). **[Review: architecture]**

## 7. Defense-in-depth on tier (without auto-detection)

Tier stays 100% explicit and human-supplied — Dispatch never infers it, and
never silently defaults it if omitted (the command errors instead). This was
kept as-is from the original design; the security review's concern was not
that this is wrong, but that it has an obvious human-error failure mode
(typing `--tier 2` out of habit on a task that actually contains a secret).

Mitigation added: a **non-blocking local warning**, not a gate. Before
dispatching, Dispatch runs a fast local regex/entropy scan for secret-shaped
content (PEM headers, common API key patterns, high-entropy tokens). If a
match is found on a task marked tier 1 or 2, it prints a warning and asks for
confirmation — but never silently overrides the stated tier, and never blocks
non-interactively (a scripted/CI caller isn't unexpectedly halted; the
warning is logged instead). This is the same class of check already used by
the existing `atarla-egress-gate` tool elsewhere in Kevin's setup, applied
here for the same reason.

## 8. Naming and license

**Name:** `dispatch` (repo `KevinTrinhDev/dispatch`, npm package
`dispatch-cli`). Rejected names and why: `hydra` collides with the
well-known `facebookresearch/hydra` config framework and taken npm packages;
`relay` collides with Facebook's Relay GraphQL client and taken npm packages.
`dispatch` was checked against npm (`dispatch` is a small, inactive, unrelated
package; `dispatch-cli` is unclaimed) and against the open-source landscape
survey below with no dominant collision found.

**License:** Apache-2.0. Recommended over MIT for the explicit patent grant,
which matters more here than for a typical utility because Dispatch
integrates with (not reimplements) proprietary vendor CLIs (Claude Code,
Codex). Recommended over MPL-2.0 (used by the sibling `gaze` project) because
Dispatch's value is the routing logic and config, not specific files worth
protecting from silent forking the way MPL's file-level copyleft is designed
for.

## 9. Relationship to prior art

Per the ecosystem scout's review, the closest existing open-source projects
are:
- **LiteLLM** (`BerriAI/litellm`, MIT) — unified routing/gateway across LLM
  *APIs*. Closest analog for the routing-engine concept; does not touch local
  CLI subprocesses or browser sessions.
- **AWS Labs' `cli-agent-orchestrator`** (Apache-2.0) — orchestrates multiple
  installed coding-agent CLIs (Claude Code, Codex, Kiro) in parallel/sequence
  for coding tasks. Closest analog for the "shell out to real CLI agents"
  concept; assumes every task is a coding task assigned to multiple agents at
  once, not one task routed by sensitivity tier to one agent.
- **RouteLLM** (`lm-sys/RouteLLM`) — trained classifier routing between a
  cheap and expensive model. Prior art for the "static rules + fallback"
  framing generally, though its learned-router approach is intentionally not
  adopted here (see section 4).

None of these combine: routing across full local CLI agents (not raw APIs),
a browser-automation adapter for consumer chat UIs, and data-sensitivity tier
as the primary routing key. That combination is the actual justification for
building Dispatch standalone rather than contributing to one of the above —
this will be stated plainly in the README rather than implied, per the
scout's recommendation, along with explicit credit to all three projects
above.

## 10. Testing

- Each static rule is independently unit-testable: given (task shape, tier),
  assert expected provider or "no rule matched, cascade proceeds."
- Adapter contract is tested against a fake/mock subprocess for each of the
  four `AdapterResult` states (ok, partial, timeout, error), not just the
  happy path.
- Audit log redaction is tested explicitly: a Tier 0 task's full text must
  never appear in the log file, only its hash and truncated preview.
- gaze's Tier 0 hard-block is tested as a standalone case that cannot be
  bypassed by rule ordering or cascade escalation.

## 11. Open items for future specs (not this one)

- Task decomposition / subagent spawning
- Memory/graph knowledge store
- Security hardening beyond the tier gate (sandboxing execution, broader
  threat model)
- Desktop overlay UI
- Whether the rule table should evolve toward a declarative policy-engine
  shape (OPA/Rego-style) once it grows past what a flat table can express
  clearly — flagged by the architecture review as the right long-term
  direction, explicitly not built in v1.
