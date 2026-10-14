# Loop Engine — Master Plan

Global autonomous engineering loop for opencode. Engine and guardrails live
globally; each repository supplies an **adapter** describing its own gates,
guardrails and risk floor.

Integrates the 11-stage pipeline from the project `CLAUDE.md`, with the loop
engine supplying the parts a document cannot enforce: evidence gates, a
plugin-written state ledger, a model ladder with fallback, adversarial review,
and a live portal.

---

## 1. Current state

Sections 2–8 are the design and remain the reference. This table and §9 are
status, kept honest.

| Component | Path | State |
|---|---|---|
| Guard plugin | `~/.config/opencode/plugins/loop-guard.ts` | working, **648 tests green** (V2) |
| Orchestrator | `~/.config/opencode/agent/loop.md` | `opencode-go/longcat-2.5-preview-free` |
| Ladder agents | `~/.config/opencode/agent/loop-*` | 16 agents, 3 rungs each |
| Protocol | `~/.config/opencode/skill/loop-engine/SKILL.md` | working |
| Adapter skill | `~/.config/opencode/skill/loop-adapter/SKILL.md` | working |
| Commands | `/loop`, `/portal`, `/tunnel` | working |
| Portal daemon | `~/.config/opencode/loop/portal.mjs` | **booted and verified** |
| Portal launcher | `~/.config/opencode/loop/start-portal.mjs` | the only supported way to start |
| Portal UI | `~/.config/opencode/loop/ui.html` | Chrome tabs, 11 stages, adapter switcher, MCP panel |
| Self-test | `~/.config/opencode/loop/selftest.mjs` | 115 assertions, 16 sections |
| Tailscale | Funnel on 7317 | `anubhav.tailee8d9c.ts.net` |
| PESDac adapters | `.loop/adapters/pesdac{,-backend}.json` | both live, switchable at runtime |

Verified working: gate recording, gate invalidation on edit, test-weakening
block, per-session ledger isolation, rate-limit classification, waivers, verdict
capture, event streaming, resilience to malformed input, MCP tool observation,
live adapter switching without restart, heartbeat throttling.

Verified over HTTP: `/health` 200, unauthenticated `/api/*` 401, token
`/api/runs` 200, root redirect 302, `/api/narrate` 403, and `POST /api/adapter`
returning 200/404/400/401 across valid, unknown, missing-repo, relative-path,
traversal and unauthenticated cases.

Bugs found and fixed by that testing, recorded because each was silent: UTF-8
corruption in the gate-verdict regexes, an un-imported `readdirSync` swallowed by
`read()`, adapter switches never reaching the ledger, and the adapter watcher
resetting the heartbeat clock.

---

## 2. The integrated pipeline

Replaces the current 7-node graph. All 11 stages always render; skipped stages
show `SKIPPED` with a reason. Hiding skipped work hides the decision.

| # | Stage | Executor | Model | Skippable |
|---|---|---|---|---|
| 0 | ORIENT / DISCOVER | orchestrator | `glm-5.3` | never |
| 1 | DEFINE | orchestrator | `glm-5.3` | small tier only |
| 2 | ARCHITECT | orchestrator | `glm-5.3` | small tier, unless floored |
| 3 | PLAN | orchestrator | `glm-5.3` | small tier only |
| 4 | IMPLEMENT | `loop-implement-N` | ladder r1→r3 | never |
| 5 | VERIFY | `loop-verify-code-N` | ladder r1→r3 | never |
| 5b | VISUAL | `loop-verify-visual-N` | ladder r1→r2 | when no UI file touched |
| 6 | HARDEN | `loop-harden` | `gpt-6-luna` | small tier, unless floored |
| 7 | REVIEW | `loop-review-N` | ladder r1→r3 | small tier, unless floored |
| 8 | PRODUCTIONIZE | orchestrator | `glm-5.3` | never |
| 9 | SHIP | `loop-scribe` | free | never |
| 10 | REPORT | `loop-scribe` | free | never |

Stages 0–3, 8 run inside the orchestrator and must announce themselves through
`loopstage`, otherwise the portal cannot distinguish "not started" from
"finished and quiet".

---

## 3. Risk tier and the plugin-enforced floor

`CLAUDE.md` §17 lets small changes skip ARCHITECT, HARDEN and REVIEW. §21
forbids "it's just a small change". The document contradicts itself, and an
autonomous loop resolves that contradiction downward, silently.

So the tier is decided twice and the **lower** answer loses:

- **Declared** — orchestrator classifies at stage 0, on the record.
- **Floored** — the plugin scans every edited path for high-risk categories and
  raises the floor. The orchestrator may raise its own tier freely; it may
  never go below the floor.

High-risk path categories:

| Category | Matches |
|---|---|
| auth / authorisation | `auth`, `session`, `login`, `password`, `permission`, `rbac`, `acl`, `token`, `jwt`, `oauth` |
| schema / migration | `migration`, `schema`, `alembic`, `drizzle`, `.sql` |
| payments | `payment`, `billing`, `stripe`, `checkout`, `subscription` |
| secrets | `.env`, `secret`, `credential`, private key material |
| infrastructure | `docker`, `deploy`, `ci`, `.github/workflows`, `nginx`, `terraform` |

Any match floors the run at **high**, which makes stages 2, 6 and 7
non-skippable. An adapter may add categories and may raise the floor. No
adapter may lower it.

This is the same defence as the test-weakening block: a cheap self-assessment
must not be able to buy a cheaper gate.

---

## 4. Adapters

Live at `.loop/adapter.json` in the repository, git-tracked, so the guardrails
travel with the code and a reviewer can see them.

```jsonc
{
  "name": "PESDac",
  "floorRisk": "high",
  "mandatoryStages": [0,4,5,6,7,8,9,10],
  "gates": {
    "code":   ["npm test", "npm run test:e2e"],
    "visual": ["npm run test:e2e"]
  },
  "highRiskPaths": ["frontend/src/theme/**", "backend/**/auth*"],
  "forbidden": [
    "Never modify src/theme/PESDacMockupTheme.ts",
    "Never add Tailwind or any CSS framework",
    "Never replace an Astryx component with custom HTML/CSS",
    "Never assert element presence as proof of paint"
  ],
  "visualRequired": "auto",
  "docsRoot": "docs/",
  "lessons": "LESSONS.md"
}
```

**No adapter** → built-in `generic`, with risk floored at medium and a loud
badge in the portal. The run proceeds; you just know it was unguarded.

### Precedence, highest first

1. Project `AGENTS.md` — hard project law, outranks everything
2. Adapter `forbidden` rules
3. `CLAUDE.md` engineering rules
4. General best practice

This exists because `CLAUDE.md` is self-contradictory today: §22 states Astro +
StyleX and *no Tailwind*, while §23 states Next.js App Router and *Tailwind for
styling* — and the project `AGENTS.md` forbids Tailwind outright. A naive
ingest would install an instruction to break the project's own UI rules. The
precedence order makes that unresolvable in the safe direction.

---

## 5. Stage signalling

The orchestrator announces stage transitions with a tiny command. The plugin
observes it by command pattern, exactly as it already observes test commands —
no new machinery, no new tool, no model call.

```
loopstage declare  0 orient risk=medium "one-line fix in retrieval lib"
loopstage enter    4
loopstage skills   6 "security-and-hardening,observability-and-instrumentation"
loopstage pass     5 "npm test: 42 passed, typecheck clean"
loopstage fail     6 "no input validation on createChat"
loopstage skip     2 "small tier, and adapter does not floor this run"
loopstage note     8 "migrations: none, env vars documented in README"
```

The plugin matches `/loopstage/,(\w+),(\d+)(?:,(\w+)=("[^"]*"|\S+))?(?:,\s*(.*))?/`
and emits a `stage` event with the parsed fields. The result is what the portal
renders, so a stage cannot look done without a recorded outcome.

---

## 6. Model ladder

`opencode-go` only. One master, everything else dispatched.

| Role | Rung 1 | Rung 2 | Rung 3 |
|---|---|---|---|
| orchestrator | `glm-5.3` | — | — |
| implement | `muse-spark-1.3-contributor` | `mimo-v2.6-flash` | `minimax-m3` |
| review | `gpt-6-luna` | `qwen3.8-flash` | `longcat-2.5-preview-free` |
| verify-code | `longcat-2.5-preview-free` | `step-5-preview-free` | `longcat-2.5-preview-free` |
| verify-visual | `qwen3.8-flash` | `mimo-v2.6-flash` | — |
| harden | `gpt-6-luna` | `minimax-m3` | — |
| scribe / ship | `longcat-2.5-preview-free` | — | — |
| gather | `longcat-2.5-preview-free` | — | — |
| ui | `gpt-6-luna` | — | — |

No node grades itself: `deepseek` implements, `gpt-6-luna` reviews,
`muse-spark` runs the code gate. Three families across the three nodes that
matter most.

**Rungs move as a pair.** Sliding implement without review lands both on the
same family and the review becomes a rubber stamp.

### Rate limits, two classes with opposite correct behaviour

| Class | Signal | Action |
|---|---|---|
| Transient | 429 / 529 / 503, `overloaded`, `capacity` | retry same rung a few times, then descend **if a rung exists**, continue automatically |
| Usage exhausted | 403, `usage limit`, `quota`, `weekly`, `5-hour`, `billing` | **the paid tier is gone, the run is not.** Route every remaining node to `opencode-go/longcat-2.5-preview-free` and label the run `DEGRADED`. The free pool is a separate quota, so this is a tier change, not a halt. Gates still have to `PASS` |
| Ladder exhausted | all rungs failed | halt, report which rungs were tried |

`Retry-After` / `x-ratelimit-reset` / a reset timestamp in the body is parsed
into a countdown. When absent the portal says `reset time unknown` rather than
guessing.

### Hard bottom line

If a role's ladder is exhausted, stop and report. Do not substitute another
role's model and do not accept a degraded gate verdict. A model too weak to
determine a gate reliably returns `unknown` at best and a wrong `pass` at worst.

---

## 7. Portal

Daemon on `127.0.0.1:7317`, auto-started by the plugin on the first loop
session, self-terminating 15s after the last session stops. No router port, no
lingering process.

Chrome-style tabs: one main tab per **repo**, one sub-tab per **session**.
Parallel work in one repo is two sub-tabs, not two servers.

Per session: status banner, 11-stage pipeline, gate panel, todo list, issues,
activated specialists, event feed, optional narrative.

### The narrator is garnish, never load-bearing

The status line is synthesised locally by rules from ledger facts. Always
available, always true, instant, free:

| Ledger state | Shown |
|---|---|
| all gates valid, review ship | `Ready to commit` |
| 3/5 nodes, in verify | `On track. 3/5 nodes done, in verify-code.` |
| 3 identical failures at one location | `Stuck — same failure 3× at file:line` |
| usage limit | `Halted. Account usage limit. Every rung is affected.` |
| transient limit, descended | `Rate limited — descending 1→2, continuing` |
| no event for 90s | `Stopped. Last activity 4m ago.` |

The model narrator is an optional overlay generated on demand. It is
**unavailable in exactly the case you most want it** — an account-wide usage
limit blocks the narrator too — so the portal must be complete without it. That
is why the facts view is the product.

### Adapter section, per subtab

Shows: adapter name, source (`repo .loop/adapter.json` or `generic` fallback
with a warning badge), floored risk tier, declared tier, mandatory stages,
active stage, gate commands, and the `forbidden` rules in force.

---

## 8. Exposure and the security boundary

One daemon, bound to loopback. ngrok tunnels to it. No nginx needed — it
would be a second layer doing one job.

- **Read paths** (dashboard, SSE) are reachable publicly behind a bearer token.
- **`/api/narrate` is refused** unless the daemon was started with
  `LOOP_PORTAL_NARRATE=1`, because it spawns a model process on this machine.
- First visit with `?t=<token>` sets an HttpOnly cookie and rewrites the URL
  without the token, so it does not linger in browser history.
- Regenerate by deleting `portal-token`; the daemon mints a new one on start.

Read exposure still leaks repository paths, filenames and test output, so the
token is load-bearing. Rotate it when a link is shared or leaked.

---

## 9. What is still open

Ordered by what actually blocks trust, not by convenience.

1. **No real loop has run through all 11 stages.** Everything so far is unit
   tests plus direct API calls. The single highest-value action is a throwaway
   `/loop` on a scratch repo, watched end to end. The stage machinery has never
   been exercised by an actual orchestrator.
2. **MCP and multi-adapter UI are not yet visually verified.** The switch
   endpoint is proven over HTTP and the plugin picks up the new adapter, but the
   switcher control and the MCP panel have never been painted in a browser.
   Presence is not paint.
3. **The adapter switcher hides when an adapter declares no forbidden rules.**
   It is nested inside the forbidden-rules card, so a permissive adapter would
   lose the control entirely.
4. **The model ladder is uncalibrated**, ordered by naming convention rather than
   by measured success. Rung 0 of each ladder is the first thing to re-test
   under real load.
5. **Parallel runs in one repo still share a git index, dev-server port and
   build output.** The portal surfaces this; it does not prevent it.
6. **Tokens were exposed in session transcripts.** The `ts.net` hostname and
   ngrok host are both discoverable, so the token is the entire security
   boundary, and it has been pasted into chat. Delete
   `~/.local/share/opencode/loopguard/portal-token` to rotate; the next start
   mints a fresh one.

Not a gap, by design: the portal self-terminates ~15s after the last loop session
ends, and the narrator is refused unless explicitly enabled. Both were requested.
