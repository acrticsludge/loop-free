---
name: loop-engine
description: Use when running a task through a graph of nodes with evidence gates and adversarial review, or when asked to "run the loop", "loop this", "autonomously implement", "set up gates", "why are you still asking me", or to make a long multi-step change unattended. Also use when reasoning about whether a UI change genuinely renders, or whether a passing test suite is trustworthy.
---

# Loop Engine

A graph of typed nodes, each with an evidence gate, executed until green or
until it stops for a reason worth a human. The goal is not fewer prompts. It is
that when the loop says done, done is a provable claim rather than an asserted
one.

## The pipeline

Eleven stages, from the project `CLAUDE.md`. All of them always render, including
the ones that were skipped — a graph that only draws the stages you ran hides
the decision from you.

| # | Stage | Executor |
|---|---|---|
| 0 | ORIENT / DISCOVER | orchestrator |
| 1 | DEFINE | orchestrator |
| 2 | ARCHITECT | orchestrator |
| 3 | PLAN | orchestrator |
| 4 | IMPLEMENT | `loop-implement-N` |
| 5 | VERIFY | `loop-verify-code-N` |
| 5b | VISUAL | `loop-verify-visual-N`, when a UI file changed |
| 6 | HARDEN | `loop-harden` |
| 7 | REVIEW | `loop-review-N` |
| 8 | PRODUCTIONIZE | orchestrator |
| 9 | SHIP | `loop-scribe` (free) |
| 10 | REPORT | `loop-scribe` (free) |

Nodes fan out only when they touch disjoint file sets. Two nodes that touch the
same file always serialise.

### Stages the orchestrator owns must announce themselves

ORIENT→PLAN and PRODUCTIONIZE run inside the orchestrator, so the plugin cannot
infer them. The orchestrator announces each one with `loopstage`:

```
loopstage.mjs --verb declare --stage 0 --risk medium --note "..."
loopstage.mjs --verb enter    --stage 3
loopstage.mjs --verb skills   --stage 6 --skills "security-and-hardening" --note "..."
loopstage.mjs --verb pass     --stage 5 --note "42 passed, typecheck clean"
loopstage.mjs --verb skip     --stage 2 --note "small tier, not floored"
```

The script validates; the plugin applies. A stage cannot be marked done by
asserting it, and a stage nobody announced never appears in the portal at all.

## Precedence, highest first

1. Project `AGENTS.md` — hard project law
2. Adapter `forbidden` rules
3. `CLAUDE.md` engineering rules
4. General best practice

This is not theoretical tidiness. The `CLAUDE.md` this design was built from
contradicts itself: one section specifies Astro + StyleX and *no Tailwind*, a
later coding-standards section specifies *Tailwind for styling*, and the
project's own `AGENTS.md` forbids Tailwind outright. A naive ingest installs an
instruction to break the project's UI rules. The order makes that unresolvable
in the safe direction.

When two rules genuinely cannot both hold, stop and say so. Never resolve a
conflict downward into fewer guardrails.

## Risk tier: declared and floored

`CLAUDE.md` §17 lets small changes skip ARCHITECT, HARDEN and REVIEW, while §21
forbids "it's just a small change". The document contradicts itself, and an
autonomous loop resolves that contradiction downward and silently.

So the tier is decided twice and the higher answer wins:

- **Declared** — the orchestrator classifies at stage 0, on the record.
- **Floored** — the plugin scans every edited path and raises the floor.

| Category | Path matches |
|---|---|
| auth / authorisation | `auth`, `session`, `login`, `permission`, `rbac`, `acl`, `jwt`, `oauth`, `passkey`, `password` |
| schema / migration | `migrations`, `schema`, `alembic`, `drizzle`, `.sql` |
| payments | `payment`, `billing`, `stripe`, `checkout`, `subscription` |
| secrets | `.env`, `secret`, `credential`, `*.pem`, `*.p12` |
| infrastructure | `docker`, `deploy`, `terraform`, `.github/workflows`, `nginx`, `k8s` |

At `high`, stages 2, 6 and 7 are non-skippable, and the plugin **refuses** a skip
of those stages and records it as `BLOCKED`. An adapter may raise the floor and
add categories; no adapter may lower it.

Same defence as the test-weakening block: a cheap self-assessment must not be
able to buy a cheaper gate.

## Adapters

`.loop/adapter.json` in the repo, git-tracked, so the guardrails travel with the
code and a reviewer can see them. Author them with the `loop-adapter` skill.

No adapter → built-in `generic`, risk floored at `medium`, and the portal shows a
loud warning badge. The run proceeds; you just know it was unguarded.

## Hardening

Stage 6 runs `loop-harden`, which cannot edit. It works the trust boundary,
injection and secrets, web boundaries, interfaces, data and schema,
observability, and failure-behaviour checklists, and reports gaps with severities.

A missing item that genuinely does not apply goes in `NOT_APPLICABLE` with a
reason. A hardener that reports everything as critical trains the reader to
ignore it, so severity has to mean something.

## Lessons

If the project has a `LESSONS.md`, read it at stage 0 and append after a real
failure or a discovered project-specific trap: date, category, what happened,
root cause, fix, prevention. Do not fill it with trivia. The value is entirely in
the entries that would have saved an hour.

## State lives on disk, not in context

Conversation-resident state is why loops fail unattended: compaction, a crash,
`/clear`, or closing the laptop destroys the run, and it resumes confused.

- **Gate ledger** — `~/.local/share/opencode/loopguard/<hash>.json`. Written
  only by the plugin, from observed command results. No agent can edit it. This
  is the trust boundary; a gate is green because a command exited 0, not because
  a model said so.
- **Graph state** — `.loop/<slug>/` in the repo, holding the node list, per-node
  status, attempt count, last error, and evidence paths. Ensure `.loop/` is
  gitignored.

Any node can be re-entered from disk after a restart. That property is the
whole reason unattended runs are safe.

## The gate invariant

A gate counts as `PASS` only when all of these hold:

1. the command actually ran, in **this** session,
2. it produced a **determinate** result — an unparseable outcome is `unknown`,
   and `unknown` is treated as failure,
3. it ran **after** the most recent edit to any source or test file,
4. it was not waived.

`unknown` resolving to failure is deliberate. A gate that cannot prove itself
did not pass. This is also why the model that writes code is never the model
that runs the gate.

## Failure law

Retry is unlimited for one class only.

| Signal | Class | Action |
|---|---|---|
| New failing test, or an unseen error shape | productive | Fix, re-verify |
| Same error at the same file:line, third time | unproductive | **Stop.** More attempts cannot help; the cause model is wrong |
| Gates green, reviewer objects | disagreement | **Stop.** Two agents disagreeing is information, not a bug to grind |
| Node edited outside its blast radius | drift | **Stop.** How loops fail quietly |
| Gate `unknown` because the command is missing | infrastructure | **Stop.** Report the gap |

`productive` and `unproductive` are distinguished by whether the error carries
new information. This replaces an attempt cap: genuinely hard problems get
unbounded runs, unsolvable ones stop on the third repeat instead of burning the
budget.

## Cheat surfaces

An agent that cannot make a test pass will, given unlimited retries, make the
test not assert. Every attempt is a local improvement in pass-rate and a global
regression. It reports green. This is the defining failure mode of an
unbounded loop, and it is why gates exist.

A cheat surface is any assertion weak enough to be satisfied by the absence of
the behaviour it claims to check:

- element presence as a proxy for rendering — a real `StatusDot` once sat in the
  DOM with correct role, label, size, and opacity, and computed to a fully
  transparent background
- `test.skip`, `.only`, `.fixme`, `xit(`, `xfail`
- widened tolerances, re-recorded snapshots, mocks added to make a path pass
- a gate that reads `unknown` quietly reported as `pass`

Defences, in order: the plugin blocks weakening markers at edit time and
invalidates both gates on every edit; the reviewer node inspects test-file
diffs *before* source diffs; the visual gate asserts computed paint and
requires at least one assertion that fails on regression.

## Waivers

The escape hatch is a user-issued directive, recorded in the ledger with a
reason and surfaced in the final report:

```
/waive visual reviewed by hand on staging, 2026-09-28
```

Never self-waive. A waiver in the report is fine; a silent gap is not.

## Model ladder

One master orchestrator, `loop` on `opencode-go/glm-5.3`, holds the graph and
dispatches everything else. `opencode-go` only.

opencode has no per-request model failover — `chat.params` exposes only
temperature and token limits, `system.transform` cannot change the model, and
`config` fires once at startup. So fallback is built from what opencode actually
has: **one subagent per (role × rung)**, and the orchestrator walks the ladder.

| Role | Rung 1 | Rung 2 | Rung 3 |
|---|---|---|---|
| implement | `muse-spark-1.3-contributor` | `mimo-v2.6-flash` | `minimax-m3` |
| review | `gpt-6-luna` | `qwen3.8-flash` | `longcat-2.5-preview-free` |
| verify-code | `longcat-2.5-preview-free` | `step-5-preview-free` | `longcat-2.5-preview-free` |
| verify-visual | `qwen3.8-flash` | `mimo-v2.6-flash` | — |

No role grades itself. `deepseek-v4.1-flash` implements, `gpt-6-luna` reviews
and `muse-spark-1.3-contributor` runs the code gate — three different families
across the three nodes that matter most, so the model that writes the code is
never the model that decides whether it passed.

Rung 1 holds the full role contract. Rungs 2 and 3 are thin: they read their
rung-1 file and follow it exactly. One source of truth per role, so a ladder
change is a one-line `model:` edit.

### The rungs move as a pair

Implement and review drop together, never independently:

| Rung | implement | review |
|---|---|---|
| 1 | `deepseek-v4.1-flash` | `gpt-6-luna` |
| 2 | `deepseek-v4-pro` | `grok-4.7` |
| 3 | `minimax-m3` | `hy3` |

A reviewer on the same model family as the author inherits the author's blind
spots, and the review becomes a rubber stamp. That separation is the reason the
ladder is paired, and it outranks cost.

### Free tier

`loop-scribe` (`longcat-2.5-preview-free`) and `loop-gather` (`longcat-2.5-preview-free`)
take every node that produces no code change — commit messages, changelogs,
report prose, file inventories, docs lookups. The only justification for a paid
model is a code change or a judgement that requires reading the diff.

`longcat-2.5-preview-free` is also rung 3 of verify-code, which is the single largest
cost saving in the loop: verification runs more often than anything else and
needs no reasoning beyond an exit code and a failure message. Its agent prompt
is explicitly biased toward `unknown` over a guessed `pass`, because `unknown`
costs one retry and a false `pass` is never caught.

### When the ladder bottoms out

On a rate limit or provider failure, drop one rung and continue. The plugin
watches the retry hook and the session failure events for 429/529 and quota
text, counts each once in the ledger, and reports the count in the gate block —
so the orchestrator is told a rate limit happened without having to parse a
provider error.

**If every rung for a role is exhausted, stop the run and report.** Do not
substitute another role's model. But first check the gates block: if it reports
`USAGE EXHAUSTED`, the paid tier is gone rather than the run being blocked, and
the free pool is a separate quota. Route the remaining work to
`opencode-go/longcat-2.5-preview-free`, label the run `DEGRADED`, and keep
requiring `PASS`.
Do not substitute another role's model and do not accept a degraded gate verdict. A
model too weak to determine a gate result reliably returns `unknown` at best and
a wrong `pass` at worst. Trading the meaning of green for progress is a bad
deal, and `unknown` is a failure by design rather than an inconvenience to route
around.

## Calibration

**The ladder is uncalibrated.** These are gateway aliases whose capabilities are
unknown, ordered by naming convention (`flash` < base < `pro`/`max`, `free` =
free tier). Calibrate on real history before trusting it: take five tasks whose
correct outcome you already know, run each through two or three candidates, and
score gate-pass rate, review-catch rate, and **tokens-to-green** — the last is
what determines loop cost and the one no public benchmark reports.

Rung 0 (`glm-5.3`) is the first thing to re-test. It holds the law across a long
run, and everything above it degrades if it does.

## Per-project adapter

The engine is global; gate commands are per-project. A project declares its own
by adding a `test` script it can actually run, plus (later) a
`.loop/project.json` for anything the script names cannot express. The engine
auto-detects `npm|pnpm|yarn|bun test`, `typecheck`, `lint`, `build`, `pytest`,
`cargo test`, `go test`, `dotnet test`, and Playwright/Cypress runs from the
commands the agents actually execute.

A project with no runnable gate is not ready for the loop. Report that as
infrastructure rather than proceeding.
