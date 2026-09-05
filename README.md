# dispatch

[![License](https://img.shields.io/badge/license-Apache--2.0-blue?style=for-the-badge)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-339933?style=for-the-badge&logo=node.js)](package.json)
[![Tests](https://img.shields.io/badge/tests-vitest-6E9F18?style=for-the-badge&logo=vitest)](src)
[![Status](https://img.shields.io/badge/status-v1-orange?style=for-the-badge)](docs/superpowers/specs)

Dispatch decides which AI provider CLI should run a given task, and hands it
off — so you don't have to manually pick between a local model, a paid
subscription tool, a metered API, or a browser-driven session every time.

## What it does

```
dispatch run --tier <0|1|2> "<task description>"
```

You tell it two things: the task, and how sensitive the data in that task is
(`--tier`, always required, never guessed). Dispatch then:

1. Looks up which providers are even allowed to see data at that tier.
2. Tries the cheapest eligible one first.
3. Checks the answer actually looks like an answer (not empty, not a refusal).
4. If it doesn't, tries the next eligible provider up, and logs every step.

Add `--explain` to see exactly which provider ran, in what order, and why.

## Data tiers

| Tier | Meaning | Example |
|---|---|---|
| 0 | Never leaves this machine | Secrets, private keys, personal legal docs |
| 1 | Your own accounts only | Source code, infra config |
| 2 | Already public | Open-source code, published docs |

Tier is always supplied by you. Dispatch never infers it from task content —
see the [design spec](docs/superpowers/specs/2026-09-05-dispatch-router-design.md)
for why guessing sensitivity automatically was rejected as a design choice.

## Why this exists

The closest existing projects each solve part of this problem, not the whole
thing:

- **[LiteLLM](https://github.com/BerriAI/litellm)** unifies routing across LLM
  *APIs* — it has no concept of a local CLI subprocess or a browser session.
- **[AWS Labs' cli-agent-orchestrator](https://github.com/awslabs/cli-agent-orchestrator)**
  orchestrates multiple coding-agent CLIs in parallel — it assumes every task
  is a coding task assigned to several agents at once, not one task routed by
  data sensitivity to one agent.
- **[RouteLLM](https://github.com/lm-sys/RouteLLM)** is prior art for the
  general "cheap-first, escalate if needed" framing this project uses, though
  Dispatch intentionally uses output verification instead of RouteLLM's
  trained classifier approach — see the design spec for the reasoning.

Dispatch's actual niche: routing across full local CLI agents (not raw APIs),
keyed primarily on data-sensitivity tier rather than cost or latency alone.
A browser-automation path to consumer chat UIs is planned but not yet
implemented — see the note under Status.

## Naming

Originally prototyped under two names that turned out to collide with
existing, much larger projects — `hydra`
([facebookresearch/hydra](https://github.com/facebookresearch/hydra), a
widely-used config framework) and `relay` (Facebook's Relay GraphQL client).
`dispatch` was checked against both npm and GitHub before being locked in.

## Status

v1 covers routing and handoff only. Task decomposition, a shared memory
store, a broader security-hardening layer, and a desktop UI are each
separate, not-yet-started projects.

The `gaze` provider (browser-driven consumer chat UIs) is a **documented stub
in v1**: it is registered in the cascade and correctly excluded from Tier 0,
but its `run` method always returns an `error` result rather than driving a
real browser. Relaying a task to a browser-based chat needs a multi-step flow
(navigate, fill the input, submit, wait, scrape the response) that doesn't fit
the one-shot shell-command shape every other adapter uses; building that
properly is follow-up work, not part of v1. Dispatch will simply escalate past
`gaze` to the next eligible provider until that lands.

See
[the design spec](docs/superpowers/specs/2026-09-05-dispatch-router-design.md#11-open-items-for-future-specs-not-this-one)
for the full list.

## License

Apache-2.0. See [LICENSE](LICENSE).
