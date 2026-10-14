#!/usr/bin/env node
// A/B harness for the gate-verdict logic.
//
//   node abtest.mjs
//
// WHY THIS EXISTS
//
// The verdict and classify rules were rewritten to stop a compound command's
// wrapper exit code being read as a green gate, and to stop introspection
// commands being recorded as gates. Both fixes were tested one shaped input at a
// time in selftest.mjs, which proves each rule fires but says nothing about
// whether the rule set as a whole is BETTER. A fix that removes a false pass and
// introduces three false fails is a trade, not a fix, and nobody would notice
// from unit tests alone.
//
// So: a labelled corpus, the pre-change implementation, and the current one side
// by side, scored on the same cases. The current implementation is IMPORTED from
// the plugin, never transcribed, so this file cannot drift from what runs.
//
// The number that decides whether the change was worth making is FALSE PASSES.
// A false fail is safe-but-annoying; a false pass is the one thing this system
// must never emit.

// classify/verdict live in ../loop/gates.mjs, NOT in the plugin. opencode loads
// every named export in plugin/ as a plugin factory, so a `classify` export got
// called with a PluginInput, returned null, and poisoned the hooks array ahead of
// the real one — making the entire plugin inert.
import { classify, verdict } from "file:///C:/Users/anubh/.config/opencode/loop/gates.mjs"

// ---------------------------------------------------------------------------
// The pre-change implementation, transcribed verbatim from loop-guard.ts before
// the rewrite. Kept verbatim on purpose: an "old" that has been tidied up is not
// a baseline, it is a straw man.
// ---------------------------------------------------------------------------
const OLD_VISUAL_GATE =
  /playwright|cypress|webdriver|puppeteer|selenium|(^|[\s;&|])(npm|pnpm|yarn|bun)\s+(run\s+)?(e2e|test:e2e|e2e:[\w:-]*)/i
const OLD_CODE_GATE =
  /(^|[\s;&|])(npm|pnpm|yarn|bun)\s+(run\s+)?(test|test:[\w:-]*|typecheck|types|lint|build|check|compile)|(^|[\s;&|])(vitest|jest|mocha|tsc|eslint|ruff|pytest|tox|black|mypy|pyright|rspec)|node\s+--test|cargo\s+(test|clippy|check)|go\s+(test|vet)|dotnet\s+test|mvn\s+test|gradle\s+test|python\s+-m\s+(pytest|unittest)/i

const oldClassify = (cmd) => {
  if (OLD_VISUAL_GATE.test(cmd)) return "visual"
  if (OLD_CODE_GATE.test(cmd)) return "code"
  return null
}
const oldVerdict = (output) => {
  const code = output?.metadata?.exitCode ?? output?.metadata?.exit_code
  if (typeof code === "number") return code === 0 ? "pass" : "fail"
  const text = `${output?.title ?? ""}\n${typeof output?.output === "string" ? output.output : ""}`
  const fail = /\b(failing|failed|failures?|FAIL\b|✗|×|error:|Error:|Traceback|panic:)/i
  const pass = /\b(passing|passed|ok\b|All tests passed|0 failed|Success:|✓)/i
  if (fail.test(text) && !/\b0 failed\b/i.test(text)) return "fail"
  if (pass.test(text)) return "pass"
  return "unknown"
}

// ---------------------------------------------------------------------------
// Corpus. `want` is the verdict a human would give the gate. Every case carries
// the runner and the real shape of that runner's output, not an idealised one.
// ---------------------------------------------------------------------------
const T = (output, metadata = {}) => ({ title: "bash", output, metadata })
const E = (code) => ({ exitCode: code })

const CORPUS = [
  // ---- should PASS -------------------------------------------------------
  { name: "npm test, exit 0, jest summary", cmd: "npm test", out: T("Tests:       3 passed, 3 total", E(0)), want: "pass" },
  { name: "pytest -q, exit 0", cmd: "pytest -q", out: T("12 passed, 0 failed in 1.21s", E(0)), want: "pass" },
  { name: "npm test, exit 0, mocha style", cmd: "npm test", out: T("  42 passing (1s)\n  0 failing", E(0)), want: "pass" },
  { name: "typecheck, exit 0, tsc", cmd: "npm run typecheck", out: T("Found 0 errors. Watching for file changes.", E(0)), want: "pass" },
  { name: "playwright, exit 0, glyph report", cmd: "npx playwright test", out: T("  ✓  1 [chromium] › a.spec.ts:3:1 › renders\n  1 passed", E(0)), want: "pass" },
  { name: "playwright, exit 0, dimension in title", cmd: "npm run test:e2e", out: T("  ✓  1 renders a 2×2 grid (12ms)\n  2 passed (1.2s)", E(0)), want: "pass" },
  { name: "bun test, exit 0, '0 fail'", cmd: "bun test", out: T("0 fail, 3 pass", E(0)), want: "pass" },
  { name: "dotnet test, exit 0, 'Failed: 0'", cmd: "dotnet test", out: T("Passed! - Failed: 0, Passed: 3, Skipped: 0", E(0)), want: "pass" },
  { name: "jest, exit 0, '0 failed'", cmd: "npm test", out: T("Tests: 0 failed, 12 passed, 12 total", E(0)), want: "pass" },
  { name: "vitest, exit 0, '0 failures'", cmd: "npx vitest run", out: T("Test Files  1 passed\nTests  0 failures | 12 passed (12)", E(0)), want: "pass" },
  { name: "go test, exit 0", cmd: "go test ./...", out: T("ok  example.com/pkg 0.02s", E(0)), want: "pass" },
  { name: "cargo test, exit 0", cmd: "cargo test", out: T("test result: ok. 3 passed; 0 failed; 0 ignored", E(0)), want: "pass" },
  { name: "npm test 2>&1 (redirection, not a pipeline)", cmd: "npm test 2>&1", out: T("3 passed", E(0)), want: "pass" },
  { name: "eslint, exit 0", cmd: "npm run lint", out: T("✖ 0 problems (0 errors, 0 warnings)", E(0)), want: "pass" },

  // ---- should FAIL -------------------------------------------------------
  { name: "npm test, exit 1", cmd: "npm test", out: T("1 failing", E(1)), want: "fail" },
  { name: "pytest, exit 1", cmd: "pytest -q", out: T("1 failed, 11 passed", E(1)), want: "fail" },
  { name: "npm test, no exit code, jest fail block", cmd: "npm test", out: T("FAIL src/e2e/b.spec.ts\nTests:       1 failed, 4 passed, 5 total"), want: "fail" },
  { name: "typecheck, no exit code, TS2345", cmd: "npm run typecheck", out: T("src/a.ts(12,7): error TS2345: Argument of type 'string'"), want: "fail" },
  { name: "lint, no exit code, eslint error", cmd: "npm run lint", out: T("src/a.ts\n  3:1  error  Missing semicolon\n\n✖ 1 problem (1 error, 0 warnings)"), want: "fail" },
  { name: "playwright, no exit code, fail glyph", cmd: "npx playwright test", out: T("  ✗  1 [chromium] › a.spec.ts:3:1 › renders\n  1 failed"), want: "fail" },
  { name: "MIXED: a 0-failed line must not hide a real failure", cmd: "npm test", out: T("PASS src/unit/a.test.ts\nFAIL src/e2e/b.spec.ts\nTests:       1 failed, 4 passed, 5 total\nSnapshots:   0 failed, 0 total\n1 failing suite in CI"), want: "fail" },
  { name: "typecheck whose source line contains 'pass'", cmd: "npm run typecheck", out: T("src/auth/login.ts(12,7): error TS2345: bad\n   const pass = validate(input);"), want: "fail" },
  { name: "lint whose path contains 'pass'", cmd: "npm run lint", out: T("src/pass/a.ts\n  3:1  error  Missing semicolon"), want: "fail" },
  { name: "pytest, no exit code, bare counts", cmd: "pytest", out: T("3 failed, 0 passed"), want: "fail" },
  { name: "python traceback", cmd: "python -m pytest", out: T("Traceback (most recent call last):\nValueError: bad"), want: "fail" },

  // ---- should be UNKNOWN (fail closed) ------------------------------------
  // This is the family the original fix created: a truncated compound command
  // cannot prove green, so it must not claim green.
  { name: "TRUNCATED COMPOUND: head -5 keeps an 'ok' line", cmd: "cargo test 2>&1 | head -5; echo done", out: T("running 3 tests\ntest utils::helper ... ok", E(0)), want: "unknown" },
  { name: "TRUNCATED COMPOUND: exit 1 but truncated text", cmd: "cargo test 2>&1 | head -5; echo done", out: T("running 3 tests\ntest a ... ok", E(1)), want: "unknown" },
  { name: "the exact vector from the PESDac ledger", cmd: 'python -m pytest 2>&1 | Select-Object -First 8; Write-Output "done"', out: T("1 failed, 0 passed", E(0)), want: "fail" },
  { name: "compound, uninterpretable text", cmd: 'python -m pytest 2>&1 | Select-Object -First 8', out: T("output I cannot interpret", E(0)), want: "unknown" },
  { name: "plain command, uninterpretable text", cmd: "npm test", out: T("output I cannot interpret"), want: "unknown" },
  { name: "plain command, empty output", cmd: "npm test", out: T(""), want: "unknown" },
]

// Classification cases are scored separately: the question is "is this a gate at
// all", not "did it pass".
const CLASSIFY = [
  { cmd: "python -m playwright install --list", want: null, note: "lists browsers, asserts nothing" },
  { cmd: "npx playwright show-report", want: null, note: "opens a report" },
  { cmd: "vitest --list", want: null, note: "lists tests" },
  { cmd: "pytest --collect-only", want: null, note: "collects only" },
  { cmd: "npm ls", want: null, note: "lists packages" },
  { cmd: "pip install -e .", want: null, note: "installs" },
  // The regression family: an incidental word must not suppress a real gate.
  { cmd: "npm run test:list", want: "code", note: "script named test:list" },
  { cmd: "vitest run tests/list.test.ts", want: "code", note: "file named list.test.ts" },
  { cmd: "pytest -k list", want: "code", note: "-k list" },
  { cmd: "npm test -- --grep \"list page\"", want: "code", note: "grep value contains list" },
  { cmd: "python -m pytest -k add", want: "code", note: "-k add" },
  { cmd: "npm run build:test", want: "code", note: "build:test" },
  { cmd: "cargo test --features add", want: "code", note: "feature named add" },
  { cmd: "npm run lint:list", want: "code", note: "lint:list" },
  { cmd: "npm test", want: "code", note: "plain" },
  { cmd: "python -m pytest", want: "code", note: "plain python" },
  { cmd: "npm run test:e2e", want: "visual", note: "e2e suite" },
  { cmd: "npx playwright test", want: "visual", note: "playwright" },
  { cmd: "git log --oneline", want: null, note: "not a test" },
]

const grade = (got, want) => {
  if (got === want) return "correct"
  if (got === "pass" && want !== "pass") return "FALSE-PASS" // the dangerous direction
  if (got === "fail" && want === "pass") return "false-fail" // safe, annoying
  if (got === "fail" && want === "unknown") return "false-fail" // safe, noisy
  if (got === "unknown" && want !== "unknown") return "unknown-miss" // safe, stalls
  return "wrong"
}

const runVerdicts = (impl) =>
  CORPUS.map((c) => ({ ...c, got: impl(c.cmd, c.out) })).map((r) => ({ ...r, grade: grade(r.got, r.want) }))

const tally = (rows) => {
  const t = { correct: 0, "FALSE-PASS": 0, "false-fail": 0, "unknown-miss": 0, wrong: 0 }
  for (const r of rows) t[r.grade]++
  return t
}

const bar = (t) =>
  `${String(t.correct).padStart(3)} correct  ${String(t["FALSE-PASS"]).padStart(2)} FALSE-PASS  ${String(t["false-fail"]).padStart(2)} false-fail  ${String(t["unknown-miss"]).padStart(2)} unknown-miss`

console.log("A/B: gate verdict logic — pre-change vs current\n")
console.log(`corpus: ${CORPUS.length} verdict cases, ${CLASSIFY.length} classification cases`)
console.log("the current implementation is imported from loop-guard.ts, not transcribed\n")

const oldRows = runVerdicts((cmd, out) => oldVerdict(out))
const newRows = runVerdicts((cmd, out) => verdict(cmd, out))
const oldT = tally(oldRows)
const newT = tally(newRows)

console.log("VERDICTS")
console.log("  old (pre-change):", bar(oldT))
console.log("  new (current)  :", bar(newT))
console.log("")

let oldC = 0, newC = 0, oldB = 0, newB = 0
for (const c of CLASSIFY) {
  const o = oldClassify(c.cmd)
  const n = classify(c.cmd)
  if (o === c.want) oldC++
  if (n === c.want) newC++
  if (o !== c.want) oldB++
  if (n !== c.want) newB++
}
console.log("CLASSIFICATION")
console.log(`  old: ${oldC}/${CLASSIFY.length} correct (${oldB} wrong)`)
console.log(`  new: ${newC}/${CLASSIFY.length} correct (${newB} wrong)`)
console.log("")

console.log("CASES WHERE THEY DIFFER")
let diffs = 0
for (let i = 0; i < CORPUS.length; i++) {
  const o = oldRows[i], n = newRows[i]
  if (o.got === n.got) continue
  diffs++
  const better = grade(n.got, n.want) === "correct" && grade(o.got, o.want) !== "correct"
  const worse = grade(o.got, o.want) === "correct" && grade(n.got, n.want) !== "correct"
  console.log(`  ${better ? "FIXED  " : worse ? "BROKE  " : "shifted"} ${o.name}`)
  console.log(`           want=${o.want} old=${o.got} new=${n.got}`)
}
for (const c of CLASSIFY) {
  const o = oldClassify(c.cmd), n = classify(c.cmd)
  if (o === n) continue
  diffs++
  const better = n === c.want && o !== c.want
  const worse = o === c.want && n !== c.want
  console.log(`  ${better ? "FIXED  " : worse ? "BROKE  " : "shifted"} classify: ${c.cmd}  (${c.note})`)
  console.log(`           want=${c.want} old=${o} new=${n}`)
}
console.log("")

console.log("VERDICT")
const fpDelta = newT["FALSE-PASS"] - oldT["FALSE-PASS"]
const corrDelta = newT.correct - oldT.correct
const checks = [
  fpDelta <= 0 ? "PASS" : "FAIL",
  corrDelta >= 0 ? "PASS" : "FAIL",
  newT["FALSE-PASS"] === 0 ? "PASS" : "FAIL",
  newB <= oldB ? "PASS" : "FAIL",
]
console.log(`  [${checks[0]}] false passes did not increase      (old ${oldT["FALSE-PASS"]} -> new ${newT["FALSE-PASS"]})`)
console.log(`  [${checks[1]}] correct verdicts did not decrease (old ${oldT.correct} -> new ${newT.correct})`)
console.log(`  [${checks[2]}] new logic emits zero false passes`)
console.log(`  [${checks[3]}] classification errors did not rise (old ${oldB} -> new ${newB})`)
console.log("")
if (checks.includes("FAIL")) {
  console.log("RESULT: REGRESSION. The change is not an improvement.")
  process.exit(1)
}
console.log(`RESULT: the change is a net improvement. ${diffs} case(s) changed behaviour, ${corrDelta >= 0 ? "+" : ""}${corrDelta} correct, ${fpDelta <= 0 ? "" : "+"}${fpDelta} false passes.`)
