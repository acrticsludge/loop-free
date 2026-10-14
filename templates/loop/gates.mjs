// Gate classification and verdict for loop-guard.
//
// WHY THIS FILE EXISTS
//
// opencode loads every file in plugin/ by calling EVERY named export as if it
// were a plugin factory. loop-guard.ts used to export `classify` and `verdict`
// alongside its default plugin. Module namespace keys sort alphabetically, so
// opencode called classify(input, options) FIRST with a PluginInput object;
// its regexes did not match "[object Object]", it returned null, and that null
// was pushed into the live hooks array at index 0. Every subsequent trigger()
// then threw "Cannot read properties of null" at hook[name] before it ever
// reached the real hooks object at index 1. The entire plugin was inert: no
// <loop-engine-gates> block, no ledger, no portal, no commit gating.
//
// So classify/verdict live HERE, and loop-guard.ts imports them. This keeps the
// pure logic testable and importable from the harnesses (abtest.mjs, loadtest.mjs)
// without giving the plugin a second export surface.
//
// The logic below is moved VERBATIM from plugin/loop-guard.ts. Only TypeScript
// type annotations were stripped, because this is plain .mjs. Do not reformat,
// rename, reorder or tidy it: a single changed regex silently changes what
// counts as a gate, which is the one thing this system must never get wrong.
//
// @typedef {"code" | "visual"} GateName

const VISUAL_GATE =
  /playwright|cypress|webdriver|puppeteer|selenium|(^|[\s;&|])(npm|pnpm|yarn|bun)\s+(run\s+)?(e2e|test:e2e|e2e:[\w:-]*)/i
const CODE_GATE =
  /(^|[\s;&|])(npm|pnpm|yarn|bun)\s+(run\s+)?(test|test:[\w:-]*|typecheck|types|lint|build|check|compile)|(^|[\s;&|])(vitest|jest|mocha|tsc|eslint|ruff|pytest|tox|black|mypy|pyright|rspec)|node\s+--test|cargo\s+(test|clippy|check)|go\s+(test|vet)|dotnet\s+test|mvn\s+test|gradle\s+test|python\s+-m\s+(pytest|unittest)/i
//
// Stream redirection is NOT a pipeline separator. `npm test 2>&1` is one test
// run whose stderr is merged, and treating it as compound made the reflexive
// PowerShell invocation unable to ever produce a green gate.
const isCompound = (cmd) => /[;&|]|\n/.test(String(cmd).replace(/\d?>&\d?/g, " ").replace(/&>>/g, " "))
// A test product's name is not a test run. `playwright install --list` lists
// browsers, asserts nothing, and was previously recorded as the visual gate.
//
// Anchored deliberately. An earlier version used bare `\blist\b|\badd\b`, which
// also matched `npm run test:list`, `vitest run tests/list.test.ts` and
// `pytest -k list` — and because NARROWED_GATE is only consulted when
// classify() matches, `npm test -- --grep "list page"` then skipped the subset
// checkpoint entirely. A word filter that can be switched off by choosing a grep
// pattern is not a guardrail. So only flag positions and real flags match here.
const NOT_A_RUN =
  /(^|[\s;&|])(playwright|cypress|puppeteer|selenium|webdriver|npm|npx|pnpm|yarn|pip3?|cargo|go)\s+(install|uninstall|init|add|remove|ls|list)\b|--(?:help|version|dry-run|list|collect-only|collect)\b|\bshow-report\b/i

export const classify = (cmd) => {
  if (NOT_A_RUN.test(cmd)) return null
  if (VISUAL_GATE.test(cmd)) return "visual"
  if (CODE_GATE.test(cmd)) return "code"
  return null
}
// `output.title` is model-authored, so it is deliberately NOT part of the
// verdict text. A bash call titled "npm test ok" could otherwise decide the
// gate on its own, which is the model grading itself.
//
// Two asymmetries, both deliberate and both learned the hard way:
//
//   FAIL evidence is read from the text with every zero-failure phrase
//   REMOVED. Reading both from the same text let one `Snapshots: 0 failed`
//   line disarm the fail arm for a run that also said "1 failing suite".
//
//   PASS evidence is read from the FULL text, because a zero-failure line is
//   positive evidence in its own right.
const ZERO_FAIL = /\b0\s+(failed|failures?|fail|errors?)\b|\b(failed|failures?)\s*[:=]\s*0\b|\bFailed:\s*0\b/gi
export const verdict = (cmd, output) => {
  const text = typeof output?.output === "string" ? output.output : ""
  const stripped = text.replace(ZERO_FAIL, " ")
  // Glyphs: ✗ appears only on real failures. × is deliberately EXCLUDED — it
  // is U+00D7, which appears in Playwright test *titles* and viewport logs, so
  // treating it as failure marked green e2e runs as failed.
  // `error` is matched without a required colon so TS2345 and eslint's
  // "error  Missing semicolon" are both caught.
  const fail = /(\bfailing\b|\bfailed\b|\bfailures?\b|\bFAIL\b|✗|\berrors?\b|\bError\b|\bTraceback\b|\bpanic:)/i
  // Pass evidence must be attached to a count or a strong phrase. A bare
  // `\bpass\b` matched the echoed source line `const pass = validate(x)` in a
  // failing typecheck, because compiler errors were not in the fail set.
  const pass = /(\b\d+\s+(tests?\s+)?(passing|passed|pass|ok)\b|\bAll tests passed\b|\bFound\s+0\s+errors?\b|\bSuccess:|\b0\s+(failed|failures?|fail|errors?)\b|\b(fail(ed|ures?))\s*[:=]\s*0\b|✓)/i
  const code = output?.metadata?.exitCode ?? output?.metadata?.exit_code
  const compound = isCompound(cmd)
  if (typeof code === "number" && !compound) return code === 0 ? "pass" : "fail"
  if (fail.test(stripped)) return "fail"
  // A compound command can never return "pass" on its text alone. The wrapper
  // may have discarded the tail, and the tail is where the summary lives, so a
  // truncated failing run still prints "ok". Returning pass here would be
  // weaker than the code this replaced, which trusted the exit code.
  if (pass.test(text) && !compound) return "pass"
  return "unknown"
}