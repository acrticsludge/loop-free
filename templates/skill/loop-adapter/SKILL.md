---
name: loop-adapter
description: Use when creating, editing, or auditing a `.loop/adapter.json` file for the loop-engine — that is, when wiring a repository into the loop portal's guardrails. Triggers on "loop adapter", "adapter for this repo", "wire this project into the loop", "set up loop gates", "make the loop understand this project", a gates block that reports ADAPTER MISSING in a new repository, or when the portal shows the "generic" fallback badge and the user wants a real adapter instead.
---

# Loop Adapter Authoring

An adapter is how a repository tells the loop engine what "done" means for *it*.
Without one the engine runs on a built-in `generic` profile: no project rules, no
custom gates, no forbidden list, and a `generic` badge in the portal. With one,
the engine knows the commands, the blast radius that matters, and the rules that
must never be broken.

The adapter is read by the loop-guard plugin at session start and written into
the session ledger, so the portal can show it. It is **not** a prompt and it does
not tell the model what to do — it tells the engine what to *check*.

Write it to `.loop/adapter.json` in the repository root, and commit it. Guardrails
that live only on one machine are guardrails nobody else has.

---

## 1. Discover before you write

Never guess a command. Read the repo.

| Look at | For |
|---|---|
| `package.json` `scripts` | `test`, `lint`, `typecheck`, `build`, `e2e` |
| `pyproject.toml` / `tox.ini` / `pytest.ini` | `pytest`, `ruff`, `mypy`, `pytest --cov` |
| `Cargo.toml` | `cargo test`, `cargo clippy` |
| `go.mod` | `go test ./...` |
| `Makefile` / `justfile` | canonical task names, often the best entry points |
| CI workflow files | **the commands CI actually runs — these are the real gates** |
| `AGENTS.md` / `CLAUDE.md` | the `forbidden` list |
| directory layout | what counts as a test, a source file, a schema |

The single highest-value source is the CI config. If CI runs `npm run check`,
that is the gate — not the three scripts you think look important. A gate the
engine can run but CI cannot is a gate that lies.

Note anything that needs a build first. Most projects bake `PUBLIC_*`/`VITE_*`
values at build time, so an e2e gate must run the build with the right
environment or it will fail for a reason that has nothing to do with the change.

---

## 2. Schema

```jsonc
{
  "name": "PESDac",
  "floorRisk": "high",
  "mandatoryStages": [0, 4, 5, 6, 7, 8, 9, 10],
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

### `name` — required

Shown in the portal per tab. Use the project's real name. This is the main thing
you will read at a glance.

### `floorRisk` — `low` | `medium` | `high`

The minimum tier the engine may assume for this repo. The orchestrator may raise
its own tier freely; it can never go below this.

Set it from blast radius, not ambition. A repo that touches production
infrastructure earns `high`. A library with no deploy surface may be `medium`.

### `mandatoryStages`

Stage numbers the loop may not skip: `0` ORIENT, `1` DEFINE, `2` ARCHITECT,
`3` PLAN, `4` IMPLEMENT, `5` VERIFY, `5b` VISUAL, `6` HARDEN, `7` REVIEW,
`8` PRODUCTIONIZE, `9` SHIP, `10` REPORT.

Include `0, 4, 5, 8, 9, 10` in every adapter — those are structural. Add `2, 6, 7`
when the risk floor is `high`, or when the project genuinely forbids shipping
without them. `5b` only when visual work is part of the product.

Note the floor already blocks skipping `2/6/7` at `high` risk. `mandatoryStages`
is for the cases the floor cannot express: a repo that always wants an ADR, or
always wants a design review.

### `gates`

The commands the engine records. `code` gates are required; `visual` gates are
required only when a UI file changed, which the engine decides by extension
(`.astro .tsx .jsx .vue .svelte .css .scss .sass .less .styl .pcss`).

List real, runnable, single-purpose commands. Do not list a command that prompts.
Do not list a watch-mode command — it never exits, so the gate never resolves and
the run stalls forever.

A command the engine can classify by pattern is auto-detected even without this
field. Put a command here when it is the project's *preferred* invocation, or when
detection would pick the wrong thing.

### `highRiskPaths`

Globs that force the run to `high` risk and make `2/6/7` non-skippable. `**`
matches across separators, `*` does not.

Target things that are expensive to get wrong, not everything sensitive-looking:
generated themes, auth middleware, migrations, billing, deploy config, the files
holding secrets. A list of forty globs is the same as no list, because it floors
every run to high and the tiering stops carrying information.

### `forbidden` — the important one

Hard rules injected into every session's system context. Copy them from the
project's own `AGENTS.md` rather than inventing them — an adapter that
contradicts the project's instruction file is worse than no adapter, because it
creates two authorities.

Write them as imperatives with a reason attached when the reason is not obvious.
The model reads these on every turn, so:

- No "avoid using X" — say "never do X" or it reads as advice
- One rule per line
- Include the *why* for any rule that looks arbitrary, or it will be "helpfully"
  worked around

The engine's own precedence, highest first:

1. project `AGENTS.md`
2. adapter `forbidden`
3. `CLAUDE.md` engineering rules
4. general best practice

If the project uses a design system or component library, the rules that protect
it belong here. A real example: a theme exported from a vendor playground is
authoritative, and an agent that "improves" it has destroyed the design.

### `visualRequired` — `auto` | `always` | `never`

`auto` is right for almost everything. Use `always` for a design-system repo where
any change can shift pixels. `never` for a headless service.

### `docsRoot`, `lessons`

Where documentation goes, and the file to read before starting and append to after
a real failure. If the project has no `LESSONS.md`, omit it — the engine will not
invent the habit.

`docsRoot` is load-bearing, not a convention hint, so it has three consequences:

- **It exempts that directory from the test and risk classifiers.** A markdown
  file under `docsRoot` is never counted as a test edit and never raises the risk
  floor. That matters because `TEST_PATH` matches any `specs/` segment and
  `HIGH_RISK` matches `auth` anywhere — so a plan called `auth-login-fix.md`
  would otherwise floor the whole run at high and refuse every commit, and a file
  under `docs/**/specs/` would refuse every commit as a weakened test.
- **A run that writes nothing under it is refused a commit.** Only when
  `docsRoot` is set; a project without one is not obliged to build a
  documentation tree to earn a commit.
- **Only document extensions qualify** (`.md`, `.mdx`, `.txt`, `.rst`, `.adoc`),
  so a `docsRoot` of `src/` cannot buy an exemption for TypeScript.

Set it to a real docs directory, or omit it entirely. An empty string grants
nothing and leaves the generic strictness in place.

---

## 3. Verify it

```bash
node -e "const a=require('./.loop/adapter.json');console.log('name:',a.name,'| floor:',a.floorRisk,'| mandatory:',(a.mandatoryStages||[]).join(','))"
```

Then actually run each command in `gates` and confirm it exits non-zero when
something is broken. A gate that cannot fail is decoration.

Confirm the fallback path too: temporarily rename the file, start a session, and
check the portal shows `generic` with the unguarded warning. If you cannot see
that warning, you will not notice a silently missing adapter later.

---

## 4. Worked example — a design-system frontend

```jsonc
{
  "name": "Acme UI",
  "floorRisk": "medium",
  "mandatoryStages": [0, 4, 5, 5b, 6, 8, 9, 10],
  "gates": {
    "code":   ["npm run typecheck", "npm test"],
    "visual": ["npm run test:e2e"]
  },
  "highRiskPaths": ["src/theme/**", "src/tokens/**"],
  "forbidden": [
    "Never edit src/theme/exported.ts — it is the vendor's canonical export",
    "Never add a CSS framework to replace the component library",
    "Never build a custom component when the library already provides one",
    "Never treat element presence as proof that something renders"
  ],
  "visualRequired": "always",
  "docsRoot": "docs/",
  "lessons": "LESSONS.md"
}
```

The `visualRequired: always` is the load-bearing choice: this repo's whole risk is
that a change compiles and renders wrong, so the visual gate never gets skipped.
The last forbidden rule exists because presence assertions pass while painting
nothing — a real, proven failure mode, not a hypothetical.

---

## 5. Common mistakes

- **Guessing commands.** Read CI. Always read CI.
- **Listing a watch-mode or interactive command.** The gate never resolves.
- **Listing forty high-risk globs.** The tiering stops meaning anything.
- **`forbidden` that contradicts the project `AGENTS.md`.** Two authorities, and
  the weaker one loses at the worst moment.
- **A `forbidden` list copied from general advice** rather than the project's
  actual rules. It consumes attention without protecting anything.
- **No adapter at all** because "the generic one is fine". It is fine until the
  day the loop silently skips something only the project knew mattered.
