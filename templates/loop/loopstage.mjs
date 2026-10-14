#!/usr/bin/env node
// Stage announcer for the loop-engine pipeline.
//
// This script is deliberately dumb: it validates its arguments and prints one
// canonical JSON line on stdout. The loop-guard plugin parses that line and
// applies it to the session ledger. The script never writes state itself, so
// no stage can be marked done by anything other than observed plugin state.
//
//   loopstage.mjs --verb declare --stage 0 --risk medium --note "one-line fix"
//   loopstage.mjs --verb declare --stage 0 --files "a.ts,b.ts" --note "radius"
//   loopstage.mjs --verb enter    --stage 4
//   loopstage.mjs --verb skills   --stage 6 --skills "security-and-hardening"
//   loopstage.mjs --verb pass     --stage 5 --note "42 passed, typecheck clean"
//   loopstage.mjs --verb fail     --stage 6 --note "no input validation"
//   loopstage.mjs --verb skip     --stage 2 --note "small tier"
//   loopstage.mjs --verb note     --stage 8 --note "migrations: none"
//   loopstage.mjs --verb note     --stage 3 --doc "docs/reasonix/plans/x.md"
//
// --doc records the artifact a stage produced, so the portal and the injected
// gates block can show which spec/plan/report this run left behind. It is a
// declaration, not a proof: the plugin separately observes real writes under the
// adapter's docsRoot, and a disagreement between the two is itself a signal.
//
// --files is the declared blast radius. It is not decoration: the radius is what
// adapter auto-selection reads, and commit gating refuses to commit without it.
// A radius derived from "what is already modified" is not a radius, so the
// orchestrator has to state it.
//
// Verbs: declare | enter | pass | fail | skip | blocked | note | skills
// Stages: 0..10, plus 5b for the visual gate.

const argv = process.argv.slice(2)

const get = (name) => {
  const i = argv.indexOf(`--${name}`)
  if (i === -1) return undefined
  const next = argv[i + 1]
  if (next === undefined || next.startsWith("--")) return true
  return next
}

const verb = get("verb")
const stage = get("stage")
const note = get("note")
const risk = get("risk")
const filesRaw = get("files")
const skillsRaw = get("skills")
const docRaw = get("doc")

const VERBS = new Set(["declare", "enter", "pass", "fail", "skip", "blocked", "note", "skills"])
const fail = (m, code = 1) => {
  process.stderr.write(`loopstage: ${m}\n`)
  process.exit(code)
}

if (!verb || verb === true) fail("--verb is required")
if (!VERBS.has(String(verb))) fail(`unknown verb "${verb}"; expected one of ${[...VERBS].join(", ")}`)
if (stage === undefined || stage === true) fail("--stage is required")
if (!/^(10|[0-9]|5b)$/.test(String(stage))) fail(`--stage must be 0..10 or 5b, got "${stage}"`)
if (typeof note === "boolean" || (note === undefined && verb !== "skills")) fail("--note is required for that verb")
if (note !== undefined && String(note).length < 3) fail("--note is too short to be useful; say what actually happened")
if (skillsRaw !== undefined && typeof skillsRaw !== "boolean" && !String(skillsRaw).trim()) fail("--skills was empty")

const out = {
  verb: String(verb),
  stage: String(stage),
  note: typeof note === "boolean" ? "" : String(note ?? "").slice(0, 300),
}
if (risk && risk !== true) out.risk = String(risk).slice(0, 20)
if (filesRaw !== undefined && filesRaw !== true) {
  out.files = String(filesRaw)
    .split(",")
    .map((f) => f.trim())
    .filter(Boolean)
    .slice(0, 200)
}
if (skillsRaw && skillsRaw !== true)
  out.skills = String(skillsRaw)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 12)
if (docRaw !== undefined && typeof docRaw !== "boolean" && String(docRaw).trim())
  out.doc = String(docRaw).trim().slice(0, 200)

process.stdout.write(JSON.stringify(out) + "\n")
