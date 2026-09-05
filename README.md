<p align="center">
  <img src="assets/banner.png" alt="dispatch — routes a task to the right AI provider CLI, by tier" width="100%">
</p>

Dispatch decides which AI provider CLI should run a given task, and hands it
off — so you don't have to manually pick between a local model, a paid
subscription tool, or a metered API every time.

```
dispatch run --tier <0|1|2> "<task description>"
dispatch run --tier <0|1|2> --decompose "<complex multi-part task>"
dispatch run --tier <0|1|2> --decompose --parallel 4 "<complex multi-part task>"
```

You give it two things: the task, and how sensitive the data in it is
(`--tier`, always required, never guessed). Dispatch tries the cheapest
provider allowed at that tier, checks the answer actually looks like an
answer, and escalates to the next one if not. `--explain` shows the full
trace.

With `--decompose`, Dispatch first asks an eligible provider (at the *same*
tier) to split a compound task into self-contained subtasks, then routes each
subtask independently through the cascade and composes the answers — so a big
task gets several focused runs instead of one stretched one. Subtasks always
inherit the run's explicit tier; Dispatch never re-tiers or downgrades them.

`dispatch --help` lists every flag; `dispatch --version` prints the version.
Every run appends a tier-redacted record to `~/.dispatch/audit.jsonl`.

## Features

| | |
|---|---|
| ✅ | Tiered routing — explicit `--tier`, never inferred |
| ✅ | Cascade-with-verification: cheapest eligible provider first, escalates on empty/refused/failed output |
| ✅ | Optional task decomposition (`--decompose`): split a compound task into subtasks routed at the same tier, then compose the answers |
| ✅ | Optional concurrent subtasks (`--decompose --parallel <N>`): run up to N subtasks at once (default sequential) |
| ✅ | Adapters for a local model, a metered API, Codex, and Claude Code — all real installed CLIs, no reimplemented SDKs |
| ✅ | Argv-array subprocess exec only — no shell-string interpolation |
| ✅ | Per-run timeout with SIGTERM → SIGKILL escalation |
| ✅ | Tier-redacted, concurrency-safe audit log |
| ✅ | Local secret-shaped-content scan, non-blocking |
| ✅ | `--explain` routing trace with per-attempt status and failure reason |
| 🚧 | Browser-automation adapter (`gaze`) — registered and tier-gated, stub for now |
| ⬜ | Shared memory across runs |
| ⬜ | Desktop overlay UI |

## Data tiers

| Tier | Meaning | Example |
|---|---|---|
| 0 | Never leaves this machine | Secrets, private keys, personal legal docs |
| 1 | Your own accounts only | Source code, infra config |
| 2 | Already public | Open-source code, published docs |

Dispatch never infers tier from task content — see the
[design spec](docs/superpowers/specs/2026-09-05-dispatch-router-design.md)
for why.

## How it's different

Most of the well-known names in this space in 2026 are **full agent
harnesses** — they run their own agent loop, memory, and tool execution.
Dispatch deliberately isn't one. It's a thin routing layer that sits in
front of agents you already have installed, and picks one per task based on
data-sensitivity tier, not on how capable a harness looks in a benchmark.

| | Dispatch | [DeepSeek Harness](https://github.com/deepseek-ai) | [OpenCode](https://opencode.ai) | [Hermes Agent](https://github.com/NousResearch/hermes-agent) |
|---|---|---|---|---|
| What it is | A router in front of existing CLIs | A full plugin-based agent runtime | A full terminal-native coding agent | A full model-agnostic agent with memory |
| Has its own agent loop / tools | No — delegates to installed CLIs | Yes | Yes | Yes |
| Primary routing key | Data-sensitivity tier | N/A (one agent per session) | Model choice, not sensitivity | N/A |
| Persistent memory | No (v1) | Plugin-dependent | No | Yes, core feature |
| License | Apache-2.0 | MIT | MIT | Open source |

None of these route *across* other agents by data sensitivity — they're
each a destination Dispatch could point at, not a competitor to the routing
layer itself.

## Roadmap

- [x] Task decomposition into routed subtasks (v1.1, `--decompose`)
- [x] Concurrent subtask execution within a decomposed run (`--decompose --parallel <N>`, opt-in)
- [ ] Real `gaze` browser-automation flow, replacing the current stub
- [ ] Standalone subagent spawning / long-lived concurrent agents (beyond one run's subtasks)
- [ ] Shared memory / knowledge store across runs
- [ ] Broader security-hardening layer beyond the tier gate
- [ ] Desktop overlay UI

## Status

v1 covers routing and handoff only. An optional `--decompose` step (v1.1)
splits a compound task into same-tier subtasks and composes their answers; see
the [decomposition spec](docs/superpowers/specs/2026-09-05-dispatch-decomposition-spec.md).
The `gaze` provider is a **documented
stub**: registered in the cascade, excluded from Tier 0, but its `run`
always returns an error instead of driving a real browser — relaying a task
to a browser chat needs a multi-step flow (navigate, fill, submit, scrape)
that doesn't fit the one-shot shell-command shape every other adapter uses.
Dispatch escalates past it to the next eligible provider until that lands.

Full list of what's not built yet:
[design spec §11](docs/superpowers/specs/2026-09-05-dispatch-router-design.md#11-open-items-for-future-specs-not-this-one).

## License

Apache-2.0. See [LICENSE](LICENSE).
