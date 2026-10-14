// V2 plugin (opencode 2.0): this module default-exports { id, setup } for the
// @opencode/plugin definition shape. Deliberately no runtime import, so the
// file stays loadable by plain Node (loop/selftest.mjs) as well as by opencode.
import { createHash, randomBytes } from "node:crypto"
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
// The learning fence lives in ../loop/priors.mjs and is shared with learn.mjs,
// because two copies of a fence is a fence that will drift.
//
// It is imported DYNAMICALLY and tolerantly on purpose. This was originally a
// static import, which made the plugin's ability to LOAD depend on
// ../loop/priors.mjs resolving. opencode loads plugins with Bun, and a plugin
// that fails to load comes back as null — at which point opencode calls
// .dispose on null and every session fails with "Unexpected server error". A
// missing or unresolvable loop/ directory could not start the tool at all. Now
// a failure here costs the memory layer and nothing else.
// lessonsPointer is optional for the same reason renderLearned is: an older
// priors.mjs on disk must not stop the plugin loading, it just costs the block.
type LearnedModule = {
  renderLearned?: (repo: string, now?: number) => string
  lessonsPointer?: (repo: string, rel: string) => string
}
let learnedMod: LearnedModule | null = null
void import("../loop/priors.mjs")
  .then((m) => {
    learnedMod = m as LearnedModule
  })
  .catch(() => {
    learnedMod = null
  })

import { isAbsolute, join, relative, resolve, sep } from "node:path"
import { spawn } from "node:child_process"

const DATA_DIR = join(homedir(), ".local", "share", "opencode", "loopguard")
// Cross-process mutex for spawning the portal. See ensurePortal.
const PORTAL_LOCK = join(DATA_DIR, "portal.lock")
const RUNS_DIR = join(DATA_DIR, "runs")
const EVENTS_DIR = join(DATA_DIR, "events")
const TOKEN_FILE = join(DATA_DIR, "portal-token")
const PORTAL_SCRIPT = join(homedir(), ".config", "opencode", "loop", "portal.mjs")
const PORTAL_PORT = 7317
const STATE_VERSION = 3

const TEST_PATH =
  /(^|[\\/])(tests?|e2e|__tests__|specs?|integration)([\\/]|$)|(\.|_|-)(test|spec)\.[a-z0-9]+$|(^|[\\/])test_[^\\/]+$/i
const UI_EXT = /\.(astro|tsx|jsx|vue|svelte|css|scss|sass|less|styl|pcss)$/i
const VISUAL_GATE =
  /playwright|cypress|webdriver|puppeteer|selenium|(^|[\s;&|])(npm|pnpm|yarn|bun)\s+(run\s+)?(e2e|test:e2e|e2e:[\w:-]*)/i
const CODE_GATE =
  /(^|[\s;&|])(npm|pnpm|yarn|bun)\s+(run\s+)?(test|test:[\w:-]*|typecheck|types|lint|build|check|compile)|(^|[\s;&|])(vitest|jest|mocha|tsc|eslint|ruff|pytest|tox|black|mypy|pyright|rspec)|node\s+--test|cargo\s+(test|clippy|check)|go\s+(test|vet)|dotnet\s+test|mvn\s+test|gradle\s+test|python\s+-m\s+(pytest|unittest)/i
// A compound command's exit code belongs to the wrapper, not the runner.
// `python -m pytest 2>&1 | Select-Object -First 8; Write-Output done` exits 0
// with a failing suite, because Select-Object is the last pipeline stage and
// $LASTEXITCODE is never propagated. Trusting that code records a green gate on
// a red suite, so a numeric code on a compound command proves nothing.
//
// Stream redirection is NOT a pipeline separator. `npm test 2>&1` is one test
// run whose stderr is merged, and treating it as compound made the reflexive
// PowerShell invocation unable to ever produce a green gate.
const COMPOUND = /[;&|]|\n/
const isCompound = (cmd: string) => /[;&|]|\n/.test(String(cmd).replace(/\d?>&\d?/g, " ").replace(/&>>/g, " "))
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
const AUTO_ALLOW = [
  /(^|[\s;&|])git\s+(status|diff|log|show|rev-parse|ls-files|branch|remote|blame|describe|shortlog)\b/i,
  /(^|[\s;&|])(npm|pnpm|yarn|bun)\s+(run\s+)?(test|test:[\w:-]*|typecheck|types|lint|lint:[\w:-]*|build|check|compile|e2e|test:e2e|verify)(\s|$|--)/i,
  /(^|[\s;&|])(npx|pnpm dlx|bunx)\s+(playwright|vitest|jest|tsc|eslint|astro)\b/i,
  /(^|[\s;&|])(vitest|jest|tsc|eslint|ruff|pytest|tox|black|mypy)\b/i,
  /loopstage\.mjs\b/i,
  /node\s+--test\b/i,
  /cargo\s+(test|clippy|check)\b/i,
  /go\s+(test|vet)\b/i,
  /dotnet\s+test\b/i,
]
const HARD_DENY = [
  /git\s+push\b[^;&|]*(--force|-f\b|--force-with-lease)/i,
  /git\s+reset\s+--hard\b/i,
  /git\s+clean\b[^;&|]*-[a-z]*[fd][a-z]*\b/i,
  /git\s+checkout\s+--\s*\./i,
  /git\s+restore\s+(--staged|--worktree)?\s*\S+\s*$/i,
  /git\s+commit\b[^;&|]*--no-verify/i,
  /git\s+(branch\s+-D|reset\s+.*--hard)/i,
  /\brm\s+-[a-z]*[rf][a-z]*\s+\/(?!\w)/i,
  /(^|[\s;&|'"`])(drop|truncate)\s+(table|database|schema)\b/i,
  // Commit prohibitions. `git commit -a` and `git add -A` stage the whole
  // working tree, which in a repo with unrelated in-flight work means claiming
  // someone else's changes as the loop's. The loop stages explicit radius paths.
  /(^|[\s;&|])git\s+add\s+(?:-{1,2}[A-Za-z]*[Aa][A-Za-z]*|-{1,2}u\b|\.\.|\.)(\s|$)/i,
  /\bgit\s+commit\b[^;&|]*(--amend|--no-verify|--allow-empty|--all|--interactive)/i,
  /\bgit\s+commit\b[^;&|]*\s-{1,2}[A-Za-z]*a[A-Za-z]*\s/i,
  /\bgit\s+commit\b[^;&|]*(--force|-F\b)/i,
]
// A commit is the one action in the loop that is hard to walk back, so it is
// conjunctive: every condition holds or the commit does not happen. Green gates
// alone are not review, and a green run on a high-risk path is not a low-risk
// change however well it tested.

const classify = (cmd: string): GateName | null => {
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
const verdict = (cmd: string, output: any): "pass" | "fail" | "unknown" => {
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

const COMMIT_BATCH = /\bgit\s+commit\b/i

// ── (a) DELETED 2026-10-02: THE EXEC LINE IS NOT GROUND TRUTH. DO NOT RE-READ IT.
//
// Gone, with no replacement in this file: `EXEC_PREFIX`, `execArgvOn`,
// `execArgvOf`, `renderArgv`. They parsed a line of the form
//
//   [loopgate] EXEC {"argv":["npm","test"],"cwd":"..."}
//
// out of the TOOL OUTPUT and treated its `argv` as the command that had run. That
// was a real CRITICAL, measured through the real `tool.execute.after` hook:
//
//   command = node -e "console.log('[loopgate] EXEC {\"argv\":[\"npm\",\"test\"],...}')"
//   output  = that one line, exitCode 0
//   result  = code gate {"state":"pass","command":"npm test"}
//
// The child authored the line. A command that never ran npm test recorded a green
// code gate and the ledger showed the forged command verbatim. The verdict on the
// whole approach, verbatim: "it trusts a self-reported line in the child's output
// as ground truth, and that line is forgeable by the child."
//
// WHY THERE IS NO THIRD WAY. Nothing in a tool result distinguishes the wrapper's
// words from the child's. Both arrive on the same merged stream, in the same
// lines, with the same bytes. Any prefix that a child can also type is a prefix
// the child controls, so a parser over that stream is a parser whose every
// accepted input is attacker-chosen -- that is the class, not a bug in one
// implementation of it.
//
// loopgate.mjs STILL PRINTS THE LINE, for humans, and it is still asserted by
// loopgate.selftest.mjs. It is diagnostic output and nothing more. The plugin does
// not READ it and must never be changed to read it: no field of it reaches the
// recorded command, the exit code, or the adapter decision. It IS REMOVED from the
// value handed to verdict(), by the anchored `EXEC_LINE` shape match below — removal
// is not parsing, and removal is what stopped the selector echo recorded there. The
// post-run command comes from `i.args.command` -- the model's REQUEST, which no
// child can forge -- through TRIVIAL_WRAPPER, the same whitelist permission.ask
// uses, and an invocation that whitelist declines is judged WHOLE.

// loopgate.mjs writes one heartbeat line per tick to STDERR, and the shell merges
// stderr into the tool result, so the heartbeat arrives inside `output.output` and
// verdict() scans it as if it were test output. Its LAST field is `--label`, which
// is model-authored free text, and the heartbeat is not test output -- so a
// model-chosen label could decide the gate on its own:
//
//   verdict("npm test", {
//     output:   "[loopgate] 00:01 elapsed | still running | beat 1 | All tests passed",
//     metadata: {},
//   })
//     -> "pass"
//
// `metadata: {}` is the exit code ABSENT, which really happens when the bash tool
// is interrupted mid-run. verdict() already excludes the model-authored
// `output.title` for precisely this reason and missed the label.
//
// WHY THE MATCH IS THE WHOLE LINE SHAPE, NOT THE PREFIX. Deleting every line that
// starts `[loopgate]` would also delete ordinary output that merely MENTIONS the
// wrapper -- which is what a suite testing this system prints -- and silently
// deleting real output is its own false green. So the match is anchored to the
// exact literal prefix `[loopgate] ` AND requires the heartbeat's own fields: a
// clock, ` elapsed`, `still running` and `beat N`. That is the shape loopgate.mjs
// writes and nothing else emits.
const HEARTBEAT_LINE =
  /^\s*\[loopgate\] \d{1,3}:\d{2}(?::\d{2})? elapsed \| still running \| beat \d+\b.*$/
// Applied to the value handed to verdict() ONLY. The ledger keeps the raw output,
// because the ledger is the record of what the tool actually said and a doctored
// copy of it would be worse than the bug.
//
// TWO LINE KINDS ARE REMOVED, and both are removed for the same reason: neither is
// evidence about the run. The heartbeat's last field is a model-authored `--label`.
// The EXEC line is the wrapper's own `JSON.stringify` of the argv it spawned, so its
// only pass/fail vocabulary is the SELECTOR the model chose, echoed back:
//
//   [loopgate] EXEC {"argv":["npm","test","--","--grep","Success:"],"cwd":"C:/repo"}
//
// A selector is a query. It is not a result. `Success:` and `All tests passed` are
// both in verdict()'s pass regex, so on a run whose output is that line the argv
// alone decides the gate.
//
//   THE ATTACK, NAMED SO IT IS NOT RE-INTRODUCED: SELECTOR ECHO. An interrupted run
//   — exit code ABSENT, which is what a bash tool cut mid-gate really returns — has
//   no numeric arm, so verdict() falls through to its text arms, where the wrapper's
//   diagnostic supplies the model's own substring as the result. Measured through the
//   real `tool.execute.after` hook:
//     command = node loopgate.mjs -- npm test -- --grep Success:
//     output  = [loopgate] EXEC {"argv":[...,"--grep","Success:"],...}
//     metadata = {}                     => gates.code.state === "pass"
//
// The earlier comment here claimed the leftover EXEC line "can only ever be a FALSE
// RED, never a false green". THAT WAS FALSE. It had only considered verdict()'s FAIL
// arm. The PASS arm reads the full text and `--grep Success:` satisfies it, so the
// same line forged a green too — the expensive direction — and the asymmetry the
// comment relied on did not exist. The claim was the reason nobody stripped the line
// for a whole round. Both directions are now gone, because the line is gone from the
// verdict text.
//
// WHAT THIS IS NOT, AND MUST NEVER BECOME. This is REMOVAL, NOT PARSING. Nothing here
// reads, extracts, decodes or interprets the EXEC line, and no field of it reaches
// the recorded command. That command still comes from
// `trivialCommand(rawCmd) ?? rawCmd` -- `i.args.command`, the model's REQUEST, the
// one thing about the run the child cannot author. Stripping and trusting are
// opposites: a strip decides only "is this whole line the wrapper's diagnostic?",
// and answers `no` by leaving the bytes exactly as they were. It cannot manufacture a
// command, a gate or a verdict out of the line it removed. selftest.mjs section 49
// pins the forgery closed, and section 50 pins that the selector is inert in both
// directions while genuine output stays visible.
//
// WHY THE MATCH IS THE WHOLE LINE SHAPE, NOT THE PREFIX. Deleting every line starting
// `[loopgate] EXEC` would also delete ordinary output that merely MENTIONS the
// wrapper -- which is what a suite testing this system prints -- and silently
// deleting real output is its own false green. So the match is anchored at BOTH
// ends: the exact literal prefix `[loopgate] EXEC `, ONE space, then a whole line of
// JSON object (RFC 8259 member grammar, which loopgate.mjs's own `JSON.stringify`
// output always satisfies), then end of line and nothing else. A line that starts the
// same way and is not that shape is left in, and if it carries a verdict phrase the
// verdict reads it -- which is correct, because then a suite really did print it.
//
// The wrapper's OTHER lines -- `[loopgate] PASS/FAIL/TIMEOUT` -- are deliberately NOT
// stripped. The FAIL line is genuine failure evidence and deleting it would weaken
// the gate; the TIMEOUT line carries no verdict phrase.
// EXEC_LINE. Every group below is NON-CAPTURING on purpose: the pattern is used with
// `.test()` to answer one yes/no question and must never hand a field to a caller, so
// there is no group here that a future edit could quietly start reading.
//
// A JSON scalar: string, number, boolean or null. Every leaf JSON.stringify emits.
// Values are built by DEPTH so `argv` (an array of strings) is admitted at the depth
// loopgate.mjs actually uses and not arbitrarily deep. Depth 2 covers every field it
// can write -- argv, cwd, and the optional route's strings -- and keeps the pattern
// readable, which matters because the next reader has to check it by eye.
const J_STR = '(?:"(?:[^"\\\\]|\\\\.)*")'
const J_NUM = "-?\\d+(?:\\.\\d+)?(?:[eE][-+]?\\d+)?"
const J_SCALAR = `(?:${J_STR}|true|false|null|${J_NUM})`
const jValue = (d: number): string =>
  d <= 0
    ? J_SCALAR
    : `(?:${J_SCALAR}` +
        `|\\[(?:\\s*${jValue(d - 1)}(?:\\s*,\\s*${jValue(d - 1)})*\\s*)?\\]` +
        `|\\{(?:\\s*${J_STR}(?::${jValue(d - 1)})?(?:\\s*,\\s*${J_STR}(?::${jValue(d - 1)})?)*)\\s*\\}` +
        `)`
// A whole line of JSON object: `"k": <value>` members, comma separated, and NOT ONE
// CHARACTER BEYOND the closing brace. Anchoring at both ends is the whole safety
// property: a prefix match would delete genuine suite output that merely mentions the
// wrapper, and silently deleting real output is its own false green.
const EXEC_LINE = new RegExp(
  "^\\s*\\[loopgate\\] EXEC \\{\\s*" +
    `${J_STR}(?::${jValue(2)})?(?:\\s*,\\s*${J_STR}(?::${jValue(2)})?)*` +
    "\\s*\\}\\s*$",
)
const stripWrapperLines = (output: any): any => {
  const text = output?.output
  if (typeof text !== "string" || !text.includes("[loopgate]")) return output
  const clean = text
    .split("\n")
    .filter((l) => !HEARTBEAT_LINE.test(l) && !EXEC_LINE.test(l))
    .join("\n")
  return clean === text ? output : { ...output, output: clean }
}

// Normalise a failure down to something that recurs identically. The failure law
// says "same error, same file:line, 3rd time -> stop", but that count was made
// by the model from conversation history, which compaction destroys: after two
// compactions the model literally cannot tell it has already tried this twice.
// Counting here makes the rule enforceable across a compaction boundary.
const errorShape = (detail: string): string => {
  const line =
    String(detail ?? "")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l && /error|fail|assert|exception|traceback|cannot|unable|expected/i.test(l)) ?? ""
  return line
    .replace(/[0-9a-f]{8,}/gi, "<hex>")
    .replace(/[A-Za-z]:\\[^\s'"]+/g, "<path>")
    .replace(/\b\d+\b/g, "<n>")
    .replace(/`[^`]*`/g, "<v>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120)
}

const noteError = (l: Ledger, detail: string) => {
  const shape = errorShape(detail)
  if (!shape) return
  const prev = l.errors.find((e) => e.shape === shape)
  if (prev) {
    prev.count++
    prev.lastAt = Date.now()
  } else {
    l.errors.push({ shape, count: 1, lastAt: Date.now() })
    l.errors = l.errors.slice(-30)
  }
}

// What compaction would otherwise destroy. Facts only, no prose: this is a
// restore point, not a status report. Bounded hard, because it is appended to
// the compaction prompt and the prompt's own job is to shrink the transcript.
const carryBlock = (l: Ledger): string => {
  const lines: string[] = []
  lines.push("The following are DURABLE FACTS recorded by the loop guard. They are not in the conversation any more. Carry them into the summary verbatim, as a fenced block titled `LOOP CARRY`, and keep every line.")
  if (l.goal) lines.push(`- goal: ${l.goal}`)
  else lines.push(`- goal: NOT RECORDED for this session. After compaction you will not be able to recover it. Ask the user to restate it rather than continuing from a half-remembered summary.`)
  // Stated even when absent. Silence here reads as "nothing to carry" when it
  // actually means "this run failed to declare one", and that failure is itself
  // the thing compaction would erase.
  if (l.declaredFiles.length) lines.push(`- blast radius (do not edit outside this): ${l.declaredFiles.join(", ")}`)
  else lines.push(`- blast radius: NEVER DECLARED. If you have not declared one, do not edit anything yet; declare it at stage 0 with --files.`)
  const st = Object.entries(l.stages ?? {})
    .map(([k, s]) => `${k}=${s.state}`)
    .join(" ")
  if (st) lines.push(`- stages: ${st}`)
  if (l.nextAction) lines.push(`- next action: ${l.nextAction}`)
  if (l.nodes.length) {
    const byRole = new Map<string, string[]>()
    for (const n of l.nodes) {
      const key = n.role.replace(/-\d+$/, "")
      byRole.set(key, [...(byRole.get(key) ?? []), `${n.rung || "?"}:${n.model}${n.outcome ? `->${n.outcome}` : ""}`])
    }
    lines.push(`- nodes already dispatched, per role (DO NOT re-dispatch a rung listed here unless the failure law says to): ${[...byRole].map(([r, v]) => `${r} [${v.join(", ")}]`).join("; ")}`)
  }
  if (l.outcome) lines.push(`- last verdict: ${l.outcome}`)
  const repeated = (l.errors ?? []).filter((e) => e.count >= 2)
  if (repeated.length) lines.push(`- errors seen more than once: ${repeated.map((e) => `${e.count}x ${e.shape}`).join(" | ")}`)
  const open = (l.todos ?? []).filter((t) => t.status !== "completed" && t.status !== "cancelled")
  if (open.length) lines.push(`- open todos: ${open.map((t) => `[${t.status}] ${t.content}`).join("; ")}`)
  const blocked = (l.commitBlocks ?? []).slice(-1)[0]
  if (blocked) lines.push(`- last commit was refused because: ${blocked.reason}`)
  // Docs written so far, because "which spec is this run building" is a question
  // only this run's answer to, and the answer is on disk rather than in context.
  if ((l.docsWritten ?? []).length) lines.push(`- docs written this run under the adapter docsRoot: ${(l.docsWritten ?? []).join(", ")}`)
  lines.push(`- gate facts are re-injected every turn from the ledger; do not trust any remembered gate state over the injected block.`)
  return lines.join("\n")
}
const CHEAT_MARKERS =
  /(\b(?:it|test|describe|suite)\s*\.\s*(?:skip|only|fixme)\b)|(\b(?:xit|xdescribe|xtest)\s*\()|(@pytest\.mark\.(?:skip|xfail)\b)|(\.only\s*\(\s*['"`])/i
// A narrowed test run is not a passing gate. This has to cover every way a
// runner lets you run a SUBSET, or the code gate goes green on a fraction of
// the suite. Gated behind classify() returning a gate, so breadth costs an ask
// on a test command, never a block on ordinary work.
const NARROWED_GATE =
  /(--grep\b|--fgrep\b|--filter\b|\s-g\s|\s-k\s|\s-m\s|\s-t\s|\s-run\b|--testNamePattern\b|--last-failed\b|--failed\b|--changed\b|--shard\b|--exclude\b|--ignore\b|--deselect\b|--only\b|--test\s+\S|\s--\s+[\w.\\/-]+|(^|\s)[\w.\\/]*\b(?:tests?|specs?|e2e)[\/]|(^|[\s;&|])[^\s\\/]*[\\/][^\/\s]*(?:test|spec)[._-]|\btest_[^\\/\s]+\.py\b|(^|\s)(?:tests|specs|e2e)\b)/i
const WAIVER_DIRECTIVE = /(?:^|\n)\s*\/?waive\s+(code|visual|test-cheat)\s*(?::|—|-|\s)\s*(.{4,})/i
// Agents the owner runs in yolo mode. The two forced asks below are skipped for
// them; HARD_DENY, commit gating and the config deny list still apply.
const YOLO_AGENTS = new Set(["loop-free", "build", "loop-free-implement-1", "loop-free-implement-2", "loop-free-gather", "loop-free-harden", "loop-free-review-1", "loop-free-review-2", "loop-free-scribe", "loop-free-verify-code-1", "loop-free-verify-code-2", "loop-free-verify-visual-1"])

// ═══════════════════════════════════════════════════════════════════════════
// DELETED 2026-10-02. DO NOT RE-ADD A COMMAND PARSER HERE. THE CLASS IS UNSAFE.
//
// Gone, with no replacement in this file: `unwrapLoopgate`, `scanWord`,
// `LOOPGATE_BASENAME`, `LOOPGATE_RUNTIME`, `LOOPGATE_OPTS`, `SHELL_OP` — ~150
// lines whose only job was to guess, from a command STRING, what would actually
// execute. It had a real CRITICAL in four consecutive hardening rounds, every
// one the same mistake:
//
//   1. 50+ paraphrases defeated an earlier prose fence (that killed a different
//      design, but the shape repeated).
//   2. `\;` — a backslash before a statement separator — hid the `;`, so a
//      compound command's exit code got trusted and a green code gate was
//      recorded on a command that only printed text.
//   3. `\ ` — a backslash before a SPACE — merged two tokens and DROPPED the
//      leading one, which walked `git push --force` and `rm -rf /` straight past
//      HARD_DENY.
//   4. `\"` inside quotes shifted token boundaries; and PowerShell's native
//      argument binding drops empty-string arguments in a way that is not part
//      of the PowerShell parser AT ALL, so no string-level parser can model it
//      faithfully.
//
// The final harden verdict, verbatim: "CAN THIS PARSER EVER BE SAFE BY PATCHING:
// no. The class is inherent to guessing a command from a string."
//
// So the guess is gone from BOTH sides, by construction, and BOTH sides now use
// the SAME mechanism -- the whitelist defined immediately below this block:
//
//   PRE-EXECUTION  (permission.ask)       `trivialCommand(pattern) ?? pattern`
//   POST-EXECUTION (tool.execute.after)   `trivialCommand(rawCmd)   ?? rawCmd`
//
// The one difference between them is only WHAT the string is, and that difference
// is the whole fix:
//
//   permission.ask gets the model's REQUEST, before the command exists.
//   tool.execute.after gets the same REQUEST, after the tool ran. `i.args.command`
//   is what the model asked to be run, so it is the one thing about the run that
//   the child cannot author.
//
// The earlier post-execution design did NOT use the request. It read the argv out
// of the child's own output, which is why it could be forged by the child; that
// mechanism is deleted (see section (a) above). Do not reintroduce any reader of
// the tool output, and do not write a second way of splitting a command string:
// the answer is in section 4 above, and it will be wrong in the expensive
// direction within one round of review.
//
// Declining is not a loss of coverage, it is a change of which string is judged.
// An invocation outside the grammar is judged WHOLE, so classify() still sees the
// test command inside it, HARD_DENY still sees the wrapped deny, NARROWED_GATE
// still sees the wrapped subset, and isCompound still sees the operator. Every one
// of those is asserted in selftest.mjs section 48 and 49.
// ═══════════════════════════════════════════════════════════════════════════

// ── (b) THE WHITELIST. ONE TRIVIALLY-TOKENISABLE GRAMMAR, AND NOTHING ELSE ────
//
// THIS IS NOT A PARSER, AND THE DIFFERENCE IS THE WHOLE POINT.
//
//     <runtime> <path>/loopgate.mjs ( --<flag> <value> )* -- <token>*
//
// where every token is matched in full against `[A-Za-z0-9._:@/+-]+` and the only
// separators permitted are SINGLE SPACES. The pattern is anchored at both ends, so
// it either recognises the ENTIRE invocation or nothing does.
//
// WHY THAT IS SAFE WHERE A PARSER WAS NOT. The class of bug that produced five
// criticals is a token boundary that the reader places somewhere other than where
// the shell places it: `\;` hides a separator, `\ ` merges two tokens, `\"` moves
// a boundary, and a line a child typed is a boundary the child chose. This grammar
// has no escape character, no quoting, no operators, no substitution and no second
// reading -- there is no alternative tokenisation of the same characters for it to
// disagree with. Harden verified it BY EXECUTION: every accepted input is
// single-space-separated tokens from a metacharacter-free class, so no shell
// tokenises it differently, and every rejected input contains a metacharacter or
// bad spacing. Anything the pattern does not recognise is DECLINED.
//
// The cost of declining is that the raw string is judged instead. That is the SAFE
// direction in every arm, and each arm is asserted rather than argued:
//
//   · a wrapped hard-deny is still DENIED, because the raw string still contains
//     the deny and nothing here truncates a string at an operator;
//   · a wrapped narrowed run is still ASKED, because the wrapper's own ` -- ` is
//     itself a NARROWED_GATE arm and because the inner `--grep` is still visible;
//   · a wrapped LEGITIMATE gate is still RECORDED, because classify()
//     substring-matches and `npm test` is inside the string;
//   · a genuinely compound string still fails isCompound().
//
// The cost of accepting wrongly would be a guardrail judging a command that did not
// run, which is the one error this file must never make. So it fails closed, every
// time.
//
// WHY LITERAL SPACES AND NOT `\s`. `\s` also matches \t and \n, so a trailing
// newline would satisfy it -- and a newline must decline. The end anchor is
// `$(?![\s\S])` rather than `$` for the same reason: in JavaScript `$` also
// matches immediately before a trailing \n.
//
// WHY THE SLICE IS NOT A RE-TOKENISATION. The capture is the whole remainder after
// ` -- `, verbatim, cut at a position the pattern itself proved. It was matched
// token by token against a class that excludes every character a shell treats
// specially, so the cut cannot land inside a token and nothing can be dropped.
const TRIVIAL_TOKEN = "[A-Za-z0-9._:@/+-]+"
const TRIVIAL_WRAPPER = new RegExp(
  "^" +
    // A runtime that executes a local file. Package managers are deliberately
    // absent and it no longer matters whether they are: with no parser, an
    // invocation they introduce is simply not in this grammar and declines.
    "(?:node|bun|deno|tsx|ts-node)(?:\\.exe|\\.cmd|\\.bat|\\.ps1)? " +
    // The wrapper's own path. Forward slashes only: a backslash is declined by
    // construction, which is the cheap direction on Windows.
    "(?:" + TRIVIAL_TOKEN + "/)?loopgate\\.mjs" +
    // Only the three valued flags loopgate.mjs itself accepts, each with a
    // trivial value. An unknown --flag is the wrapper's own usage error.
    "(?: --(?:heartbeat|timeout|label) " + TRIVIAL_TOKEN + ")*" +
    // The exact ` -- ` separator, then the command: trivial tokens, single
    // spaces. A command needing quotes or spaces in a token declines.
    " -- " + TRIVIAL_TOKEN + "(?: " + TRIVIAL_TOKEN + ")*" +
    "$(?![\\s\\S])",
)
const trivialCommand = (pattern: string): string | null => {
  const m = TRIVIAL_WRAPPER.exec(pattern)
  return m ? m[0].slice(m[0].indexOf(" -- ") + 4) : null
}

const HIGH_RISK = [
  { cat: "auth", re: /(^|[\\/])(auth|authn|authz|login|signin|signup|session|permission|permissions|rbac|acl|jwt|oauth|passkey|password)([\\/.]|$)/i },
  { cat: "schema", re: /(^|[\\/])(migrations?|alembic|schema|drizzle)([\\/]|$)|\.sql$/i },
  { cat: "payments", re: /(payment|billing|stripe|checkout|subscription|invoice)/i },
  { cat: "secrets", re: /(^|[\\/])\.env|(secret|credential|private[-_]?key|\.pem$|\.p12$)/i },
  { cat: "infra", re: /(^|[\\/])(docker|deploy|terraform|\.github[\\/]workflows|nginx|k8s|helm)([\\/]|$)/i },
]

// Prose written by the loop is an artifact, not code, and the two classifiers
// above both misread it and punish an honest run for documenting itself:
//
//   TEST_PATH matches any `specs/` directory segment, so docs/reasonix/specs/**
//     counted as a TEST edit. That set testEditsSinceGreen, which is a
//     permanent commit blocker until a green gate runs again -- so the moment
//     the loop wrote a spec, it could no longer commit the run.
//   HIGH_RISK matches `auth` anywhere in a path, so a plan legitimately called
//     auth-login-fix.md floored the whole run at high, which makes stages 2/6/7
//     non-skippable and refuses every commit, over a markdown file.
//
// Both are right for source and wrong for prose, so a path under the adapter's
// declared docsRoot is exempted. The extension check is the second half of the
// guard: a docsRoot of `src/` must not buy an exemption for TypeScript, so only
// real document files qualify. An empty docsRoot grants nothing at all, which
// keeps the generic fallback adapter exactly as strict as before.
const DOC_EXT = /\.(md|mdx|txt|rst|adoc)$/i
const isDocPath = (adapter: Adapter | undefined, relPath: string): boolean => {
  const declared = (adapter?.docsRoot ?? "").trim()
  if (!declared) return false
  const prefix = declared.replace(/\\/g, "/").replace(/^\.?\/+/, "").replace(/\/+$/, "")
  if (!prefix) return false
  const norm = String(relPath).replace(/\\/g, "/").replace(/^\.\//, "")
  return (norm === prefix || norm.startsWith(prefix + "/")) && DOC_EXT.test(norm)
}

const GENERIC_ADAPTER = {
  name: "generic",
  source: "fallback",
  file: "",
  available: [] as string[],
  floorRisk: "medium",
  mandatoryStages: [0, 4, 5, 7, 8, 9, 10],
  forbidden: [] as string[],
  highRiskPaths: [] as string[],
  gates: {} as Record<string, string[]>,
  visualRequired: "auto",
  docsRoot: "",
  lessons: "",
}

type Adapter = typeof GENERIC_ADAPTER

const stripJsonc = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")

const listAdapters = (root: string): Array<{ name: string; file: string }> => {
  const out: Array<{ name: string; file: string }> = []
  const dir = join(root, ".loop", "adapters")
  if (existsSync(dir)) {
    try {
      for (const f of readdirSync(dir)) {
        if (f.endsWith(".json")) out.push({ name: f.replace(/\.json$/, ""), file: join(dir, f) })
      }
    } catch {}
  }
  const single = join(root, ".loop", "adapter.json")
  if (existsSync(single)) out.push({ name: "default", file: single })
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

const activeName = (root: string): string => {
  const p = join(root, ".loop", "active-adapter")
  try {
    return existsSync(p) ? readFileSync(p, "utf8").trim() : ""
  } catch {
    return ""
  }
}

// Coverage an adapter promises. Comparing these is what stops auto-selection
// from trading a gate away for a tidier match.
const coverageOf = (a: Adapter): { ui: boolean; code: boolean; count: number } => ({
  ui: (a.visualRequired ?? "auto") !== "never" && (a.gates?.visual ?? []).length > 0,
  code: (a.gates?.code ?? []).length > 0,
  count: (a.gates?.code ?? []).length + (a.gates?.visual ?? []).length,
})

// Pick an adapter for a declared radius, or return null to keep the active one.
//
// The ordering is deliberate and is the correction to "score every adapter, best
// score wins": that let a convenient adapter win by being cheaper, which is
// exactly the trade §2.1 of the design doc forbids. Risk floor and gate coverage
// are decided first and workload fit only breaks ties among equals, so the
// cheapest gate can never win on price.
const RISK_ORDER = { low: 0, medium: 1, high: 2 } as Record<string, number>
const selectAdapter = (root: string, files: string[]): { adapter: Adapter; why: string } | null => {
  if (!files.length) return null
  // An explicit active-adapter is the operator's decision and always wins.
  if (activeName(root)) return null
  const list = listAdapters(root)
  if (list.length < 2) return null
  const current = loadAdapter(root)
  const currentCov = coverageOf(current)
  const wantsUi = files.some((f) => UI_EXT.test(f))

  const ranked = list
    .map((entry) => {
      let a: Adapter
      try {
        const raw = JSON.parse(readFileSync(entry.file, "utf8")) as Partial<Adapter>
        a = { ...GENERIC_ADAPTER, ...raw, name: String(raw.name ?? entry.name), source: "repo", file: entry.file }
      } catch {
        return null
      }
      const cov = coverageOf(a)
      // Hard exclusion, not a penalty: an adapter with no visual gate must not
      // be chosen for a radius containing UI files, however well it matches
      // otherwise. Selecting one would drop Playwright entirely.
      //
      // Deliberately not conditioned on the current adapter. Gating it on
      // `currentCov.ui` let a gate-less default switch its own protection off,
      // which is the exact case the exclusion exists for.
      const excluded = wantsUi && !cov.ui
      const match = files.filter((f) =>
        (a.highRiskPaths ?? []).some((g) => {
          const rx = new RegExp(
            "^" + String(g).replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, ".*").replace(/\*/g, "[^/]*") + "$",
            "i",
          )
          return rx.test(f)
        }),
      ).length
      return {
        adapter: a,
        excluded,
        match,
        floor: RISK_ORDER[a.floorRisk] ?? 1,
        count: cov.count,
      }
    })
    .filter((x): x is NonNullable<typeof x> => !!x && !x.excluded)
    .sort((x, y) => y.floor - x.floor || y.count - x.count || y.match - x.match)

  const best = ranked[0]
  if (!best) return null
  if (best.adapter.name === current.name) return null
  // Never narrow coverage relative to what is already in force.
  const bestCov = coverageOf(best.adapter)
  if (bestCov.count < currentCov.count) return null
  const why = `auto-selected (${(best.adapter.gates?.code ?? []).join("; ") || "no gate"}; ${best.match}/${files.length} radius match)`
  return { adapter: best.adapter, why }
}

const loadAdapterFile = (file: string): Adapter | null => {
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<Adapter>
    return { ...GENERIC_ADAPTER, ...raw, name: String(raw.name ?? file), source: "repo", file }
  } catch {
    return null
  }
}

const loadAdapter = (root: string): Adapter => {
  const list = listAdapters(root)
  const names = list.map((a) => a.name)
  if (!list.length) return { ...GENERIC_ADAPTER, available: names }
  const want = activeName(root)
  const chosen = list.find((a) => a.name === want) ?? list[0]
  const loaded = loadAdapterFile(chosen.file)
  if (loaded) return { ...loaded, available: names }
  return { ...GENERIC_ADAPTER, name: `generic (${chosen.name} is invalid)`, source: "repo", file: chosen.file, available: names }
}

let mcpCache = { at: 0, servers: [] as string[] }
const mcpServers = (): string[] => {
  if (Date.now() - mcpCache.at < 10_000) return mcpCache.servers
  const names = new Set<string>()
  for (const p of [join(homedir(), ".config", "opencode", "opencode.jsonc"), join(homedir(), ".config", "opencode", "opencode.json")]) {
    if (!existsSync(p)) continue
    try {
      const cfg = JSON.parse(stripJsonc(readFileSync(p, "utf8"))) as { mcp?: Record<string, any> }
      // V2 nests servers under mcp.servers; V1 kept them directly under mcp.
      const m = cfg.mcp ?? {}
      const servers = m.servers && typeof m.servers === "object" ? m.servers : m
      for (const k of Object.keys(servers)) if (k !== "timeout") names.add(k)
    } catch {}
  }
  mcpCache = { at: Date.now(), servers: [...names] }
  return mcpCache.servers
}

const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "")
const isMcpTool = (tool: string) => {
  const t = squash(String(tool))
  return mcpServers().some((s) => {
    const q = squash(s)
    return q.length > 1 && t.includes(q)
  })
}

const riskFloor = (l: Ledger, a: Adapter): string => {
  const extra = (a.highRiskPaths ?? []).map((g) => {
    const rx = new RegExp("^" + String(g).replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, ".*").replace(/\*/g, "[^/]*") + "$", "i")
    return { cat: "adapter", re: rx }
  })
  const paths = [...(l.touched ?? []), ...extra.map(() => "x")]
  for (const rule of [...HIGH_RISK, ...extra]) {
    for (const p of l.touched ?? []) if (rule.re.test(p)) return "high"
  }
  void paths
  return a.floorRisk
}

const riskCats = (l: Ledger): string[] => {
  const found = new Set<string>()
  for (const rule of HIGH_RISK) for (const p of l.touched ?? []) if (rule.re.test(p)) found.add(rule.cat)
  return [...found]
}


const USAGE_LIMIT =
  /usage limit|quota|billing|insufficient credit|credit balance|spend limit|5[\s-]?hour|weekly|exceeded your current|not enough credit|purchase more/i
const TRANSIENT_LIMIT =
  /rate limit|too many requests|overloaded|capacity|try again later|temporarily|503|529/i
const ANY_LIMIT =
  /\b(429|529|403|503)\b|rate[\s_-]?limit|too many requests|overloaded|capacity|try again later/i

type GateName = "code" | "visual"
type Gate = {
  state: "unknown" | "pass" | "fail"
  at: number
  command: string
  detail: string
}
type Limit = {
  at: number
  cls: "transient" | "usage"
  detail: string
  resetAt: number | null
  rung: string
}
type StageRec = { state: string; at: number; note: string; skills: string[]; doc?: string }
type Ledger = {
  version: number
  repo: string
  repoName: string
  sessionID: string
  gates: Record<GateName, Gate>
  lastEditAt: number
  testEditsSinceGreen: string[]
  touched: string[]
  scratch: string[]
  declaredFiles: string[]
  docsWritten: string[]
  goal: string
  errors: Array<{ shape: string; count: number; lastAt: number }>
  compactions: number
  todos: Array<{ content: string; status: string; priority: string }>
  // When this run last CALLED todowrite, which is not the same as when the list
  // last changed: the content dedup below means an unchanged re-call writes
  // nothing, and staleness is a judgement about the model re-reading its own
  // plan. Kept on the ledger rather than in a factory Map because todoLine
  // renders from the ledger on every turn and has to see it after a reload.
  todoAt: number
  nextAction: string
  carryAt: number
  nodes: Array<{ role: string; rung: string; model: string; desc: string; at: number; outcome: string }>
  outcome: string
  uiTouched: boolean
  waivers: Array<{ gate: string; reason: string; at: number }>
  denials: Array<{ reason: string; at: number }>
  commitBlocks: Array<{ reason: string; at: number }>
  limits: Limit[]
  stages: Record<string, StageRec>
  mcp: Record<string, { count: number; at: number }>
  adapter: Adapter
  riskDeclared: string
  autoAdapter: string
  riskFloor: string
  riskCats: string[]
  runs: number
  lastActivityAt: number
  startedAt: number
}

const blank = (repo: string, repoName: string, sessionID: string, adapter: Adapter): Ledger => ({
  version: STATE_VERSION,
  repo,
  repoName,
  sessionID,
  gates: {
    code: { state: "unknown", at: 0, command: "", detail: "" },
    visual: { state: "unknown", at: 0, command: "", detail: "" },
  },
  lastEditAt: 0,
  testEditsSinceGreen: [],
  touched: [],
  scratch: [],
  declaredFiles: [],
  docsWritten: [],
  goal: "",
  errors: [],
  compactions: 0,
  todos: [],
  todoAt: 0,
  nextAction: "",
  carryAt: 0,
  nodes: [],
  outcome: "",
  uiTouched: false,
  waivers: [],
  denials: [],
  commitBlocks: [],
  limits: [],
  stages: {},
  mcp: {},
  adapter,
  riskDeclared: "",
  autoAdapter: "",
  riskFloor: "medium",
  riskCats: [],
  runs: 0,
    startedAt: Date.now(),
    lastActivityAt: Date.now(),
})

const safe = (s: string) => s.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120)
const hash = (s: string) => createHash("sha1").update(s).digest("hex").slice(0, 16)

// V2's tool.execute.after carries a structured Result instead of a flat
// { output, metadata } pair. The shell tool puts the raw text at
// result.output.output and the exit code at result.output.exit (mirrored on
// result.metadata.exit). This adapter converts either V2 result shape back into
// the { output, metadata } shape that stripWrapperLines() and verdict() already
// speak, so no decision logic forks on the API version.
const shellResult = (event: any): { text: string; exitCode: number | undefined } => {
  try {
    if (event?.status !== "completed") {
      const m = event?.error?.message
      return { text: typeof m === "string" ? m : "", exitCode: undefined }
    }
    const r = event?.result
    if (!r) return { text: "", exitCode: undefined }
    const o = r.output
    let text = ""
    if (typeof o === "string") text = o
    else if (o && typeof o === "object" && typeof o.output === "string") text = o.output
    else if (typeof r.content === "string") text = r.content
    else if (Array.isArray(r.content))
      text = r.content.map((c: any) => (c?.type === "text" && typeof c.text === "string" ? c.text : "")).join("\n")
    const exit = o && typeof o === "object" ? o.exit ?? r?.metadata?.exit : r?.metadata?.exit
    return { text, exitCode: typeof exit === "number" ? exit : undefined }
  } catch {
    return { text: "", exitCode: undefined }
  }
}

const classifyLimit = (err: any): "transient" | "usage" | null => {
  if (!err) return null
  // Reads both error shapes: V2 SessionError {type,message,status,response:{body}}
  // and the V1 shape the tests still build.
  const code = err?.status ?? err?.data?.statusCode
  const text = `${err?.type ?? err?.name ?? ""} ${err?.data?.message ?? ""} ${err?.response?.body ?? ""} ${err?.data?.responseBody ?? ""} ${err?.message ?? ""}`
  if (code === 529 || code === 503) return "transient"
  if (code === 403) return "usage"
  if (!ANY_LIMIT.test(text) && code !== 429) return null
  if (USAGE_LIMIT.test(text)) return "usage"
  if (TRANSIENT_LIMIT.test(text) || code === 429) return "transient"
  return USAGE_LIMIT.test(text) ? "usage" : "transient"
}

const resetAtOf = (err: any): number | null => {
  const h = (err?.response?.headers ?? err?.data?.responseHeaders ?? {}) as Record<string, string>
  const raw = h["retry-after"] ?? h["Retry-After"] ?? h["x-ratelimit-reset"] ?? h["x-ratelimit-reset-requests"]
  const toDate = (n: number) => (n > 1e11 ? n : Date.now() + n * 1000)
  if (raw) {
    const n = Number(raw)
    if (Number.isFinite(n) && n > 0) return toDate(n)
  }
  const m = String(err?.response?.body ?? err?.data?.responseBody ?? "").match(/"(?:reset_at|resetAt|resets_at|retry_after)"\s*:\s*"?(\d+)"?/i)
  if (m) {
    const n = Number(m[1])
    if (Number.isFinite(n) && n > 0) return toDate(n)
  }
  return null
}

// The factory below is wrapped so that a bug or a missing dependency degrades
// to an inert plugin instead of returning null. opencode calls .dispose on a
// plugin that loaded as null and then refuses to start any session, so a
// throw in here is a total tool failure, not a lost guardrail.
const __guardFactory = async (ctx: any) => {

  if (process.env.OPENCODE_LOOP_NARRATOR === "1") return null

  // V2 gives every plugin instance a location; the project directory is where
  // the V1 factory's worktree/directory pair pointed.
  const root = resolve(ctx?.location?.directory || ctx?.location?.project?.canonical || process.cwd())
  const repoName = root.split(sep).filter(Boolean).pop() ?? root
  const repoHash = hash(root.toLowerCase())

  let adapterCache = { at: 0, adapter: null as Adapter | null }
  const getAdapter = (): Adapter => {
    if (adapterCache.adapter && Date.now() - adapterCache.at < 1500) return adapterCache.adapter
    adapterCache = { at: Date.now(), adapter: loadAdapter(root) }
    return adapterCache.adapter
  }

  const ledgerPath = (sessionID: string) => join(RUNS_DIR, repoHash, `${safe(sessionID)}.json`)
  const eventPath = (sessionID: string) => join(EVENTS_DIR, repoHash, `${safe(sessionID)}.jsonl`)

  const read = (sessionID: string): Ledger => {
    try {
      const p = ledgerPath(sessionID)
      if (!existsSync(p)) return blank(root, repoName, sessionID, getAdapter())
      const parsed = JSON.parse(readFileSync(p, "utf8")) as Partial<Ledger>
      if (!parsed || parsed.version !== STATE_VERSION) return blank(root, repoName, sessionID, getAdapter())
      // An auto-selected adapter has to survive every read, or the next hook
      // would silently put the operator's default back and the run would verify
      // against the wrong gate suite.
      let active = getAdapter()
      // Only honour an auto-selection while the operator has not made an
      // explicit choice. `active-adapter` is the escape hatch and the portal
      // advertises that switching works live; without this check a run that had
      // auto-selected once was pinned to it for the whole session, and the
      // operator's switch silently did nothing.
      if (parsed.autoAdapter && !activeName(root) && parsed.adapter?.file && parsed.adapter.file !== active.file) {
        const from = loadAdapterFile(parsed.adapter.file)
        if (from) active = from
      }
      return {
        ...blank(root, repoName, sessionID, getAdapter()),
        ...parsed,
        repo: root,
        repoName,
        sessionID,
        adapter: active,
        // Suppressed at read time, not just when the watcher next persists it,
        // so the injected block never contradicts itself for up to 2 seconds
        // after the operator switches.
        autoAdapter: activeName(root) ? "" : (parsed.autoAdapter ?? ""),
      } as Ledger
    } catch {
      return blank(root, repoName, sessionID, getAdapter())
    }
  }

  // An adapter can be switched from the portal while the session is live. The
  // system block always reads the current one, but the portal reads the ledger
  // on disk, so an external switch has to be pushed into every live ledger or
  // the dashboard keeps showing the adapter that was active a minute ago.
  const seenSessions = new Set<string>()
  const autoSelect = (l: Ledger) => {
    try {
      return selectAdapter(root, l.declaredFiles ?? [])
    } catch {
      return null
    }
  }
  const sigOf = (a: Adapter) => `${a.name}|${a.source}|${(a.forbidden ?? []).length}|${a.floorRisk}`
  let lastAdapterSig = sigOf(getAdapter())
  const adapterWatch = setInterval(() => {
    try {
      const a = getAdapter()
      const sig = sigOf(a)
      if (sig === lastAdapterSig) return
      lastAdapterSig = sig
      for (const sid of seenSessions) {
        const l = read(sid)
        if (l.autoAdapter) {
          if (activeName(root)) {
            // The operator has chosen explicitly. Inference stops being the
            // authority and the stale auto reason is dropped with it. Written
            // unconditionally: the persisted adapter is already correct here
            // (read() honours active-adapter), it is the reason field that is
            // wrong, and the equality guard below would skip this.
            l.autoAdapter = ""
            l.adapter = getAdapter()
            write(sid, l)
            push(sid, { k: "adapter", name: l.adapter.name, source: l.adapter.source, floor: l.adapter.floorRisk })
            continue
          }
          const repicked = autoSelect(l)
          if (!repicked) continue
          // Only write when the pick actually differs. write() stamps
          // lastActivityAt, so a no-op here would keep refreshing the liveness
          // signal the STALLED detector reads and a hung run would look alive.
          if (sigOf(repicked.adapter) === sigOf(l.adapter)) continue
          l.adapter = repicked.adapter
          l.autoAdapter = repicked.why
          write(sid, l)
          push(sid, { k: "adapter", name: l.adapter.name, source: l.adapter.source, floor: l.adapter.floorRisk })
          continue
        }
        // No auto-selection in play: this is a real external switch, and the
        // watcher only runs when the live adapter's signature changed, so the
        // write is warranted.
        l.adapter = getAdapter()
        write(sid, l)
        push(sid, { k: "adapter", name: l.adapter.name, source: l.adapter.source, floor: l.adapter.floorRisk })
      }
    } catch {}
  }, 2000)
  adapterWatch.unref?.()

const write = (sessionID: string, l: Ledger) => {
  try {
    seenSessions.add(sessionID)
    l.riskFloor = riskFloor(l, l.adapter)
    l.riskCats = riskCats(l)
    // Stamped on every write so the injected block can say how long the run has
    // been silent. A subagent runs in a child session and its activity lands in
    // a different ledger, so without this the orchestrator has no way to tell a
    // node that is grinding from one that died an hour ago.
    l.lastActivityAt = Date.now()
    mkdirSync(join(RUNS_DIR, repoHash), { recursive: true })
    writeFileSync(ledgerPath(sessionID), JSON.stringify(l, null, 2), "utf8")
  } catch {}
}

  const buffers = new Map<string, string[]>()
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  const lastHb = new Map<string, number>()
  const lastTodo = new Map<string, string>()
  const lastRung = new Map<string, string>()

  const flush = (sessionID: string) => {
    const buf = buffers.get(sessionID)
    if (!buf?.length) return
    buffers.set(sessionID, [])
    try {
      mkdirSync(join(EVENTS_DIR, repoHash), { recursive: true })
      appendFileSync(eventPath(sessionID), buf.join("\n") + "\n", "utf8")
    } catch {}
  }

  const push = (sessionID: string, ev: Record<string, unknown>) => {
    if (!sessionID) return
    const buf = buffers.get(sessionID) ?? []
    buf.push(JSON.stringify({ ...ev, t: Date.now() }))
    buffers.set(sessionID, buf)
    lastHb.set(sessionID, Date.now())
    if (buf.length >= 64) {
      const t = timers.get(sessionID)
      if (t) clearTimeout(t)
      timers.delete(sessionID)
      flush(sessionID)
      return
    }
    if (!timers.has(sessionID)) {
      timers.set(
        sessionID,
        setTimeout(() => {
          timers.delete(sessionID)
          flush(sessionID)
        }, 500),
      )
    }
  }

  const beat = (sessionID: string) => {
    if (!sessionID) return
    const now = Date.now()
    if (now - (lastHb.get(sessionID) ?? 0) < 5000) return
    push(sessionID, { k: "hb" })
  }

  let portalTried = false
  const ensurePortal = () => {
    if (portalTried) return
    portalTried = true
    const healthy = fetch(`http://127.0.0.1:${PORTAL_PORT}/health`, {
      signal: AbortSignal.timeout(600),
    })
      .then((r) => r.json())
      .then((j) => j?.service === "loop-portal")
      .catch(() => false)
    void healthy.then((ok) => {
      if (ok || !existsSync(PORTAL_SCRIPT)) return
      // portalTried only guards THIS plugin instance, so every opencode window
      // would otherwise spawn its own daemon. Take a cross-process lock first:
      // the 'wx' flag makes the create atomic, so exactly one window wins.
      let lock = ""
      try {
        mkdirSync(DATA_DIR, { recursive: true })
        writeFileSync(PORTAL_LOCK, String(process.pid), { flag: "wx" })
        lock = PORTAL_LOCK
      } catch {
        return // another window holds the lock, or the write failed; either way do not spawn
      }
      const release = () => { try { rmSync(lock, { force: true }) } catch {} }
      // A daemon that dies unexpectedly leaves the lock behind and wedges every
      // future start, so expire it rather than trusting it forever.
      setTimeout(release, 20000)
      try {
        const child = spawn(process.execPath, [PORTAL_SCRIPT], { detached: true, stdio: "ignore" })
        child.on("error", release)
        child.unref()
      } catch {
        release()
      }
    })
  }

  const rel = (p: unknown): string => {
    if (typeof p !== "string" || !p) return ""
    const abs = isAbsolute(p) ? p : resolve(root, p)
    const r = relative(root, abs)
    if (r.startsWith("..")) return p
    return r.split(sep).join("/")
  }
  const pathArg = (args: any): string => {
    if (!args || typeof args !== "object") return ""
    for (const k of ["filePath", "path", "file"]) {
      if (typeof args[k] === "string") return rel(args[k])
    }
    return ""
  }
  const contentArg = (args: any): string => {
    if (!args || typeof args !== "object") return ""
    for (const k of ["content", "newString", "text", "patch", "replacement"]) {
      if (typeof args[k] === "string") return args[k]
    }
    return ""
  }
  const cmdOf = (args: any): string => {
    const v = args?.command ?? args?.cmd ?? args?.script
    return typeof v === "string" ? v : ""
  }


  const gateValid = (l: Ledger, g: GateName) =>
    l.gates[g].state === "pass" && l.gates[g].at > l.lastEditAt && !l.waivers.some((w) => w.gate === g)
  const visualRequired = (l: Ledger) => l.uiTouched && !l.waivers.some((w) => w.gate === "visual")

  // A commit is the one action in the loop that is hard to walk back, so it is
  // conjunctive: every condition holds or the commit does not happen. Green
  // gates alone are not review, and a green run on a high-risk path is not a
  // low-risk change however well it tested.
  const commitBlockers = (l: Ledger): string[] => {
    const out: string[] = []
    if (!gateValid(l, "code")) out.push(`code gate is ${l.gates.code.state}, not a valid PASS`)
    if (visualRequired(l) && !gateValid(l, "visual")) out.push(`visual gate is ${l.gates.visual.state} and a UI file was touched`)
    if (l.testEditsSinceGreen.length) out.push(`${l.testEditsSinceGreen.length} test file(s) edited since the last green run`)
    if (l.denials.length) out.push(`${l.denials.length} recorded denial(s) this run`)
    if (l.riskFloor === "high") out.push(`risk floor is high (${riskCats(l).join(", ") || "adapter"})`)
    if (l.outcome !== "ship") out.push(`review verdict is "${l.outcome || "none"}", not ship`)
    if (!l.declaredFiles.length) out.push("no blast radius was declared at stage 0")
    // Only when the adapter asked for docs. A repo with no docsRoot is not
    // required to invent a documentation tree to earn a commit.
    if ((l.adapter?.docsRoot ?? "").trim() && !(l.docsWritten ?? []).length)
      out.push(`no doc artifact was written under ${l.adapter.docsRoot} this run -- write the spec/plan/report and re-run the gate`)
    return out
  }

  // The loop is required to document itself so a later session can resume the
// work. A prompt instruction is a request, so this makes the fact observable:
// the line is re-sent every turn, it says plainly when nothing has been written
// yet, and a run that wrote no doc at all is refused a commit. A rule that only
// lives in the agent file is a rule the free tier forgets by stage 4.
const docsLine = (l: Ledger) => {
  const declared = (l.adapter?.docsRoot ?? "").trim()
  if (!declared) return "docs: adapter declares no docsRoot -- documentation is not enforced on this run"
  const written = l.docsWritten ?? []
  const announced = Object.entries(l.stages ?? {})
    .map(([k, s]) => ({ k, doc: s.doc }))
    .filter((x) => x.doc)
    .map((x) => `s${x.k}=${x.doc}`)
  if (!written.length && !announced.length)
    return `docs: NONE WRITTEN under ${declared} -- this run must leave a trail: DEFINE writes specs/<slug>.md, PLAN writes plans/<slug>.md, each dispatch writes prompts/, gather writes the handoff, REPORT writes reports/<slug>.md. Announce each with \`loopstage --verb note --stage N --doc <path>\`, and put those doc paths in the stage 0 --files radius or the commit will refuse them as out-of-radius.`
  return `docs: ${cap(written, 6)}${announced.length ? ` [declared: ${cap(announced, 6)}]` : ""}`
}

const statusLine = (l: Ledger) => {
    const row = (g: GateName) => {
      if (l.waivers.some((w) => w.gate === g)) return "WAIVED (see waivers)"
        if (gateValid(l, g)) return `PASS — \`${l.gates[g].command.slice(0, 80)}\``
      const p = l.gates[g]
        if (p.at > 0 && p.at <= l.lastEditAt) return "STALE — a run predates the most recent edit; re-run it"
        if (p.state === "fail") return `FAIL — \`${p.detail.slice(0, 120)}\``
      return "NOT RUN in this session"
    }
    return [
      `code:   ${row("code")}`,
      `visual: ${row("visual")} [${visualRequired(l) ? "required" : "not required (no UI files touched)"}]`,
    ].join("\n")
  }

  const limitLine = (l: Ledger) => {
    const last = l.limits[l.limits.length - 1]
    if (!last) return "rate limits: none"
    const when = last.resetAt ? `, resets ${new Date(last.resetAt).toISOString()}` : ", reset time unknown"
    // The paid Go quota and the free tier are separate pools, so an exhausted
    // 5h/1w/1m limit is not the end of the run. It is the end of the PAID tier.
    // What must not happen is the run quietly becoming weaker and still being
    // read as a normal one, so the switch is announced and gates stay required.
    return last.cls === "usage"
      ? `rate limits: USAGE EXHAUSTED at ${new Date(last.at).toISOString()}${when} — the paid tier is gone. Route every remaining node to opencode-go/longcat-2.5-preview-free and mark this run DEGRADED in the report. Gates are still required to PASS: a free rung that cannot determine a gate returns unknown, which fails. Do not weaken a gate to keep moving.`
      : `rate limits: transient at ${new Date(last.at).toISOString()}${when} — retry this rung, then descend if a rung exists.`
  }

  const stageLine = (l: Ledger) => {
    const order = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
    const names = ["ORIENT", "DEFINE", "ARCHITECT", "PLAN", "IMPLEMENT", "VERIFY", "HARDEN", "REVIEW", "PRODUCTIONIZE", "SHIP", "REPORT"]
    const done = order.filter((n) => l.stages[String(n)]?.state === "pass").length
    const active = order.find((n) => l.stages[String(n)]?.state === "enter")
    return `stages: ${done}/11 complete${active != null ? `, in ${names[active]} (${active})` : ""}${l.stages["5b"] ? `, visual ${l.stages["5b"].state}` : ""}`
  }

  const riskLine = (l: Ledger) => {
    const floor = riskFloor(l, l.adapter)
    const cats = riskCats(l)
      return `risk: declared=${l.riskDeclared || "unset"} floor=${floor}${cats.length ? ` (high-risk paths touched: ${cats.join(", ")})` : ""}${floor === "high" ? " — stages 2/6/7 are NOT skippable" : ""}`
  }

  const adapterLine = (l: Ledger) =>
    `adapter: ${l.adapter.name} [${l.adapter.source}]${l.adapter.source === "fallback" ? " -- NO project rules, run is unguarded" : ""}${l.adapter.forbidden?.length ? `, ${l.adapter.forbidden.length} forbidden rules in force` : ""}${l.adapter.available?.length > 1 ? `, ${l.adapter.available.length} adapters available` : ""}${l.autoAdapter ? `, ${l.autoAdapter}` : ""}${l.declaredFiles?.length ? `, radius: ${l.declaredFiles.length} file(s) declared at stage 0` : ""}`

  // An unwired repo is the one state where the fix is a known, one-time, skill-
  // driven pass. Say so in the block, with the file to write and the skill to
  // load, instead of leaving "unguarded" as news the agent cannot act on.
  const adapterFixLine = (l: Ledger): string => {
    const name = String(l.adapter?.name ?? "")
    const invalid = name.includes("is invalid")
    if (!invalid && l.adapter?.source !== "fallback") return ""
    const what = invalid
      ? ".loop/adapter.json exists but does not parse"
      : "this repository has no .loop/adapter.json"
    return `ADAPTER ${invalid ? "INVALID" : "MISSING"}: ${what}, so this run is unguarded -- the generic fallback has no project rules and no gates. Before stage 0: load the loop-adapter skill, discover the repo's real gates (its CI config first, then package.json / Makefile / pyproject), write .loop/adapter.json, include it in the declared radius, and continue. One-time per repo; the run's commit carries it.`
  }

const mcpLine = (l: Ledger) => {
  const entries = Object.entries(l.mcp ?? {}).sort((a, b) => b[1].count - a[1].count)
  if (!entries.length) return "mcp tools used: none yet"
  const shown = entries.slice(0, 4).map(([k, v]) => `${k} x${v.count}`).join(", ")
  return `mcp tools used: ${shown}${entries.length > 4 ? ` (+${entries.length - 4} more)` : ""}`
}

  // This block is re-sent on every single turn, so any list that grows over a
// long run multiplies into a real bill. Cap each one and say how many were
// elided: the count can change a decision, the tail almost never does.
const cap = (items: string[], n: number) =>
  items.length <= n ? items.join(", ") : `${items.slice(0, n).join(", ")} (+${items.length - n} more)`

// A dispatch that never returns looks identical to one that is working. Surface
// the silence explicitly rather than letting the orchestrator infer progress
// from an absence of bad news. Subagents write to a child ledger, so this is
// the only signal the parent has that a node is even alive.
const STALL_MS = 10 * 60 * 1000
const mins = (ms: number) => Math.floor(ms / 60000)
const dur = (ms: number) => (mins(ms) >= 1 ? `${mins(ms)}m` : `${Math.max(1, Math.floor(ms / 1000))}s`)

// A todo list is a plan, and a stale plan is worse than none: it reads as
// coverage while describing work that is no longer what the run is doing.
// 15 minutes of silence is long enough that the run has almost certainly
// moved on, and short enough that a human watching the portal would not
// call the warning premature.
const TODO_STALE_MS = 15 * 60_000

// A plan is not optional once the run is real work, and the only evidence the
// plugin has that a run has left the opening exchange is that it entered a
// stage. Stage 0 exists only to declare the blast radius, so a stage past 0
// means the run is implementing, and the plan should already be on the ledger.
const TODO_LIST_FROM_STAGE = 1

const stallLine = (l: Ledger) => {
  const idle = Date.now() - (l.lastActivityAt ?? l.startedAt ?? Date.now())
  const held = Object.entries(l.stages ?? {})
    .filter(([, s]) => s.state === "enter")
    .map(([k, s]) => ({ k, for: Date.now() - (s.at ?? Date.now()) }))
    .sort((a, b) => b.for - a.for)[0]

  const bits: string[] = []
  if (held) {
    const bad = held.for >= STALL_MS
    bits.push(`stage ${held.k} has been in enter for ${dur(held.for)}${bad ? "  <-- OVER BUDGET" : ""}`)
  }
  bits.push(`silent for ${dur(idle)}`)
  const verdict = idle >= STALL_MS || (held && held.for >= STALL_MS)
    ? "STALLED: no progress past the budget. Do NOT assume the node is working. Re-check with a cheap probe, then re-dispatch one rung down or stop."
    : "within budget"
  return `progress: ${bits.join("; ")} — ${verdict}`
}

// Read the model an agent is pinned to, from its own frontmatter. Cached because
// it is called on every task dispatch and the files do not change mid-session.
const agentModelCache = new Map<string, string>()
const agentModel = (name: string): string => {
  if (agentModelCache.has(name)) return agentModelCache.get(name)!
  let model = ""
  try {
    const p = join(homedir(), ".config", "opencode", "agent", `${name}.md`)
    if (existsSync(p)) model = /^model:\s*(\S+)/m.exec(readFileSync(p, "utf8"))?.[1] ?? ""
  } catch {}
  agentModelCache.set(name, model)
  return model
}

// A plan is not optional once the run is real work, and the plugin has two
// independent observations that the run has left the opening exchange.
//
// A stage past TODO_LIST_FROM_STAGE is the first: stage 0 exists only to declare
// the blast radius, so a stage past 0 means the run is implementing.
//
// AN EDIT IS THE SECOND, and it was the more common one. Requiring a stage meant
// a run that edited a file, entered no stage and wrote no todos produced no todo
// line at all -- which is precisely the "it forgot to make a todo list" case the
// judgement exists to catch, reported as nothing at all. lastEditAt advances for
// every write (including scratch, deliberately: invalidating early is the
// conservative direction) so it is the same signal used to invalidate a gate, and
// reusing it here cannot disagree with itself.
//
// Elapsed time was rejected and stays rejected: a session idling in a chat for
// twenty minutes has edited nothing and entered nothing, and a wall-clock rule
// would warn about a run that is doing nothing wrong and is not yet planning.
const planDue = (l: Ledger) =>
  (l.lastEditAt ?? 0) > 0 ||
  Object.entries(l.stages ?? {}).some(
    ([k, s]) =>
      Number(k) >= TODO_LIST_FROM_STAGE && ["enter", "pass", "fail", "blocked", "skip"].includes(String(s?.state ?? "")),
  )

// The plugin, not the model, decides whether the plan still describes the run.
// AGENTS.md asks for a current list and for exactly one in_progress todo, and
// those are the two things a model stops doing after a compaction, so the
// judgement is made here from observed state and injected on every turn.
//
// WARN ONLY. A stale list is advice in a system block: no refusal, no gate, no
// permission hook. A guardrail that blocked on a stale todo would be a much
// louder design than anyone asked for, and the model can act on a warning
// precisely because nothing stops it.
const todoLine = (l: Ledger) => {
  const todos = l.todos ?? []
  const open = todos.filter((t) => t.status !== "completed" && t.status !== "cancelled")

  if (!todos.length) {
    // One message for both ways a run becomes due, because the advice is the
    // same and the caller cannot see which observation fired it.
    return planDue(l)
      ? "todos: NONE -- this run is implementing and has written no plan; call the todos tool before the next step."
      : ""
  }

  const warn: string[] = []
  // Unknown is treated as stale on purpose. A list with no timestamp can only
  // come from a run that wrote todos before this handler observed them, and
  // "we cannot prove this list is current" is the same judgement as "it is not".
  const at = l.todoAt || 0
  if (open.length) {
    if (!at) warn.push("todo list stale, age unknown")
    else {
      const age = Date.now() - at
      if (age >= TODO_STALE_MS) warn.push(`todo list stale ${dur(age)}`)
    }
  }
  const inProg = todos.filter((t) => t.status === "in_progress").length
  if (inProg > 1) warn.push(`${inProg} in_progress, exactly 1 allowed`)

  if (!open.length && !warn.length) return ""
  const shown = open.slice(0, 6).map((t) => `[${t.status}] ${t.content}`.slice(0, 90))
  const head = open.length
    ? `open todos (compaction will not remember these): ${shown.join("; ")}${open.length > 6 ? ` (+${open.length - 6} more)` : ""}`
    : "todos: none open"
  return warn.length ? `${head} | WARNING: ${warn.join("; ")}` : head
}
const repeatLine = (l: Ledger) => {
  const repeated = (l.errors ?? []).filter((e) => e.count >= 2).sort((a, b) => b.count - a.count)
  if (!repeated.length) return ""
  const worst = repeated[0]
  const head = `failures that have recurred: ${repeated.slice(0, 3).map((e) => `${e.count}x ${e.shape.slice(0, 70)}`).join(" | ")}`
  // The failure law is a count the model cannot make after a compaction, so the
  // plugin makes it here instead of trusting it to remember.
  return worst.count >= 3
    ? `${head}\nSTOP LAW: the same failure has now happened ${worst.count} times. The hypothesis is wrong -- do not attempt it again. Report the run as blocked and say what you would change.`
    : head
}
const goalLine = (l: Ledger) =>
  l.goal
    ? `goal (from the start of this run; compaction will not remember it): ${l.goal.slice(0, 200)}`
    : "goal: NOT RECORDED -- if you cannot state the goal and its acceptance criteria right now, ask the user rather than continuing from a half-remembered summary."

const systemBlock = (l: Ledger, loopAgent = false) => `
<loop-engine-gates>
Authoritative state, written by the loop-guard plugin from observed results.
No agent can edit it. Treat it as ground truth.

${adapterLine(l)}
${loopAgent ? adapterFixLine(l) : ""}
${riskLine(l)}
${stageLine(l)}

${statusLine(l)}
${stallLine(l)}
${docsLine(l)}

source/test files last edited: ${l.lastEditAt ? new Date(l.lastEditAt).toISOString() : "none"}
test files touched since last green: ${l.testEditsSinceGreen.length ? cap(l.testEditsSinceGreen, 3) : "none"}
${l.scratch?.length ? `scratch files edited (outside the repo, not part of the radius or the risk floor): ${cap(l.scratch, 3)}` : ""}
waivers: ${l.waivers.length ? cap(l.waivers.slice(-3).map((w) => `${w.gate} (${w.reason})`), 3) : "none"}
${limitLine(l)}
${mcpLine(l)}
skills activated: ${cap([...new Set(Object.values(l.stages ?? {}).flatMap((s) => s.skills ?? []))].map(String), 6) || "none reported yet"}
${l.adapter.forbidden?.length ? `forbidden: ${cap(l.adapter.forbidden, 4)}` : ""}
${l.compactions ? `context compacted ${l.compactions}x this run; facts below are restored from the ledger, not remembered.` : ""}
${goalLine(l)}
${todoLine(l)}
${repeatLine(l)}
${l.declaredFiles?.length ? `blast radius: ${cap(l.declaredFiles, 12)}` : "blast radius: NOT DECLARED -- declare it at stage 0 with --files"}
${l.nodes?.length ? `nodes dispatched: ${cap((l.nodes ?? []).map((n) => `${n.role.replace(/-\d+$/, "")}/${n.rung || "?"}->${n.outcome || "?"}`), 8)}` : ""}
${l.outcome ? `last verdict: ${l.outcome}` : ""}
${(l.commitBlocks ?? []).length ? `last commit refused: ${(l.commitBlocks ?? []).at(-1)?.reason ?? ""}` : ""}
${learnedLine()}
${lessonsLine()}

Bound by this: gates above are observed, not asserted. Do not report done, and do
not commit, while a required gate is not PASS. On USAGE EXHAUSTED, the paid tier
is gone but the free tier is a separate pool: route remaining nodes to
opencode-go/longcat-2.5-preview-free and label the run DEGRADED. A gate must
still PASS — if the free rung cannot determine one, that is a failure, not a
reason to soften the gate. Precedence: project AGENTS.md > this block > CLAUDE.md
> general practice. MCP and gate results are observed here; skills are
self-reported and are not.
${loopAgent ? `PONYTAIL IS MANDATORY on this run: solve the whole problem with the least new code -- reuse what exists, then the standard library, then installed dependencies, before writing anything new; never cut validation, error handling, security, or accessibility; leave one small test for non-trivial logic; end the report with what was skipped and what was not checked. Full ladder and lenses: the ponytail skill.` : ""}
</loop-engine-gates>`

let learnedCache: { at: number; text: string } | null = null

// Fold the repo's ledgers into priors, off the critical path. Injecting priors
// is pointless unless something writes them, and the fold is model-free, so it
// can run unattended. Cooldown per repo: a long run must not spawn a node
// process per gate, and the fold reads every ledger the repo has.
let lastFoldAt = 0
const maybeFold = (sid: string) => {
  const now = Date.now()
  if (now - lastFoldAt < 10 * 60_000) return
  lastFoldAt = now
  try {
    const script = join(homedir(), ".config", "opencode", "loop", "learn.mjs")
    if (!existsSync(script)) return
    const child = spawn(process.execPath, [script, "--fold", "--repo", root], {
      detached: true,
      stdio: "ignore",
    })
    child.on("error", () => {})
    child.unref()
    push(sid, { k: "fold", at: now })
  } catch {}
}

const learnedLine = () => {
  // Not loaded yet, or failed to load. The memory layer is a nice-to-have; the
  // gates block is not, so this degrades to silence rather than throwing.
  if (!learnedMod?.renderLearned) return ""
  // Rendered once per 10 minutes and cached: this block is re-sent on every
  // turn, and re-reading two JSON files per turn is a cost for a value that
  // changes at most once per fold. The cache age matches the fold cooldown, so
  // it cannot outlive the thing it caches.
  if (!learnedCache || Date.now() - learnedCache.at > 10 * 60_000) {
    let rendered = ""
    try {
      rendered = learnedMod.renderLearned(root) ?? ""
    } catch {
      rendered = ""
    }
    learnedCache = { at: Date.now(), text: rendered }
  }
  return learnedCache.text
}

let lessonsCache: { at: number; rel: string; text: string } | null = null

// A POINTER at the repo's committed LESSONS.md, when the active adapter names
// one. It carries the path, a cheap entry count and the trust framing -- never the
// file's prose. The previous design injected entries from that file after
// fencing each one with GATE_TAKING/GATE_SHORTENING/IMPERATIVE, and harden found
// that unwinnable: a keyword blacklist over arbitrary free text has 50+ known
// paraphrases, and rendering a planted sentence inside a block headed
// "Authoritative state, written by the loop-guard plugin" stamps plugin authority
// on it. lessonsPointer reads no content at all, so this line can only ever say
// where the file is and how it is trusted -- the same level as AGENTS.md, whose
// edits are not blocked either.
//
// Same shape and same cost discipline as learnedLine: optional module member,
// 10-minute cache, silence on any failure.
//
// The cache is keyed on `rel` as well as on time. The path comes from the ACTIVE
// adapter, so keying on time alone meant that switching adapters served the
// previous repo's lessons line for up to ten minutes after the switch.
const lessonsLine = () => {
  const rel = getAdapter()?.lessons
  if (!rel) return ""
  if (!learnedMod?.lessonsPointer) return ""
  if (!lessonsCache || lessonsCache.rel !== rel || Date.now() - lessonsCache.at > 10 * 60_000) {
    let rendered = ""
    try {
      rendered = learnedMod.lessonsPointer(root, rel) ?? ""
    } catch {
      rendered = ""
    }
    lessonsCache = { at: Date.now(), rel, text: rendered }
  }
  return lessonsCache.text
}


  // Limit records arrive from two V2 sources (the retry hook and failure
  // events), which can describe one provider failure twice. Dedupe on
  // session+class+detail within 15s so the ledger and portal count an incident
  // once.
  const limitSeen = new Map<string, number>()
  const noteLimit = (sid: string, cls: "transient" | "usage", detail: string, resetAt: number | null) => {
    const key = `${sid}|${cls}|${detail.slice(0, 90)}`
    const now = Date.now()
    if (now - (limitSeen.get(key) ?? 0) < 15_000) return
    limitSeen.set(key, now)
    if (limitSeen.size > 400) {
      for (const [k, v] of limitSeen) if (now - v > 60_000) limitSeen.delete(k)
    }
    if (sid) {
      const l = read(sid)
      l.limits.push({ at: now, cls, detail, resetAt, rung: lastRung.get(sid) ?? "" })
      write(sid, l)
    }
    push(sid, { k: "limit", cls, detail, resetAt })
  }

  const handlers = {
    cleanup: async () => {
      for (const [sid] of buffers) {
        push(sid, { k: "session-end" })
        const t = timers.get(sid)
        if (t) clearTimeout(t)
        flush(sid)
      }
      try {
        clearInterval(adapterWatch)
      } catch {}
    },

    // V2: ctx.permission.hook("evaluate"). The event carries the scanner's
    // commands as `resources` (a compound command arrives as several), and the
    // decision is returned by mutating `effect`. An explicit configured deny is
    // final and never reaches this hook. There is no title in the event at all,
    // which is the outcome the note below always wanted.
    permissionEvaluate: async (event: any) => {
      try {
        if (event.action !== "shell") return
        const resources: string[] = Array.isArray(event.resources) ? event.resources.map(String) : []
// PRE-EXECUTION: THE WHITELIST, DECLARED AT MODULE SCOPE.
//
// It used to be declared here, inside this hook, because this hook was its only
// consumer. `tool.execute.after` needs the identical decision now, and a hook-local
// `const` is not reachable from another hook -- so it is at module scope with
// `stripWrapperLines`, and both sides call the same function. That is the point:
// there is exactly ONE place in this file permitted to look inside a command
// string, and it is a whitelist rather than a parser.
//
// What the whitelist buys on THIS side specifically: leaving the wrapper's own
// ` -- ` in the string would match NARROWED_GATE's `\s--\s+` arm, so every wrapped
// gate in an unattended loop would raise a prompt. `--label "x y" -- npm test`
// declines, so it gets that prompt -- which is the designed cost of declining, and
// not a hole, because the raw string it falls back to still contains the test
// command, the deny, or the subset selector that HARD_DENY and NARROWED_GATE read.

// WHY `perm.title` IS NOT PART OF THAT STRING. The title is model-authored free
// text, and the whole point of the wrapper is to REMOVE the prompt that the
// normalised command would otherwise raise -- so concatenating it defeated the
// feature on the most ordinary input there is:
//
//   pattern: node loopgate.mjs -- npm test
//   title:   Run the tests
//   joined:  "node loopgate.mjs -- npm test Run the tests"  -> "npm test Run the tests"
//   NARROWED_GATE's bare `(^|\s)(?:tests|specs|e2e)\b` arm matches "tests"
//   status:  ask      <- the exact prompt the wrapper exists to eliminate
//
// The same defect ran the other way: a title naming a hard-deny denied a benign
// command. The title is still shown to the human; it is simply never classified.
// Only the command is judged, which is the same rule verdict() already applies
// to the model-authored output.title.
//
// A declined invocation is judged on the RAW string, so a wrapped hard-deny is
// still denied: the wrapper's own syntax around it does not hide the command,
// and this file never truncates a string at an operator to look past one.
const cmds = resources.map((r) => trivialCommand(r) ?? r).filter((c) => c.length)
        if (!cmds.length) return

        const hard = cmds.find((cmd) => HARD_DENY.some((re) => re.test(cmd)))
        if (hard) {
          event.effect = "deny"
          event.message = `loop-guard: refused a hard-denied command: ${hard.slice(0, 160)}`
          const l = read(event.sessionID)
          l.denials.push({ reason: hard.slice(0, 200), at: Date.now() })
          write(event.sessionID, l)
          push(event.sessionID, { k: "deny", reason: hard.slice(0, 200) })
          return
        }
        if (cmds.some((cmd) => COMMIT_BATCH.test(cmd))) {
          // Commits are gated here rather than trusted to the prompt, because
          // the alternative is a rule a free model can talk itself out of.
          const l = read(event.sessionID)
          const blocked = commitBlockers(l)
          if (blocked.length) {
            event.effect = "deny"
            event.message = `loop-guard: refused the commit: ${blocked.join("; ").slice(0, 220)}`
            // Recorded separately from `denials`. A refused commit is not a
            // guardrail violation, and counting it as one would make the first
            // early attempt permanently block every later commit in the run.
            l.commitBlocks.push({ reason: blocked.join("; ").slice(0, 300), at: Date.now() })
            write(event.sessionID, l)
            push(event.sessionID, { k: "commit-blocked", reason: blocked.join("; ").slice(0, 300) })
            return
          }
          event.effect = "allow"
          return
        }
        if (!YOLO_AGENTS.has(String(event.agent ?? "")) && cmds.some((cmd) => classify(cmd) && NARROWED_GATE.test(cmd))) {
          event.effect = "ask"
          return
        }
        if (cmds.every((cmd) => AUTO_ALLOW.some((re) => re.test(cmd)))) {
          event.effect = "allow"
          return
        }
        if (!YOLO_AGENTS.has(String(event.agent ?? "")) && cmds.some((cmd) => TEST_PATH.test(cmd) && /(sed|perl|python -c|node -e|>\s*\S+test)/i.test(cmd))) {
          event.effect = "ask"
        }
      } catch {}
    },

    toolBefore: async (event: any) => {
      try {
        const sid = event.sessionID
        if (!sid) return
        ensurePortal()

        if (event.tool && isMcpTool(event.tool)) {
          const l = read(sid)
          const prev = l.mcp[event.tool] ?? { count: 0, at: 0 }
          l.mcp[event.tool] = { count: prev.count + 1, at: Date.now() }
          write(sid, l)
          push(sid, { k: "mcp", tool: event.tool })
          return
        }

        // V2 renamed the task tool to `subagent` and its field to `agent`.
        if (event.tool === "subagent") {
          const st = event.input?.agent
          if (typeof st === "string") {
            const rung = /-(\d+)$/.exec(st)?.[1] ?? ""
            lastRung.set(sid, rung)
            // Record the model the node actually ran on, resolved from the agent's
            // own frontmatter. Without this the ledger knows the role and the rung
            // but not the model, so there is no way to learn which model is
            // actually good at which role - the assignment stays guesswork.
            const model = agentModel(st)
            const desc = String(event.input?.description ?? "").slice(0, 160)
            const l = read(sid)
            l.nodes = [...l.nodes, { role: st, rung, model, desc, at: Date.now(), outcome: "" }].slice(-120)
            write(sid, l)
            push(sid, {
              k: "node",
              role: st,
              rung,
              model,
              desc,
            })
          }
          return
        }
        // V2 removed the built-in todo tool; the plugin re-provides it as
        // `todos`, and its recording lives in todosExecute below.
        if (!/^(edit|write|patch|multiedit|apply_patch|create)$/i.test(String(event.tool ?? ""))) return

        const p = pathArg(event.input)
        if (!p) return

        const l = read(sid)
        // Docs are recorded, never gated. This branch sits BEFORE lastEditAt on
        // purpose: the loop is required to write its report AFTER the gates are
        // green, so a doc write that advanced lastEditAt would mark both gates
        // STALE and leave the run unable to commit precisely because it
        // documented itself. Everything else about the write is still observed.
        const docAbs = isAbsolute(p) ? p : resolve(root, p)
        const docRel = relative(root, docAbs).replace(/\\/g, "/")
        if (isDocPath(l.adapter, docRel)) {
          l.docsWritten = [...new Set([...(l.docsWritten ?? []), docRel])].slice(-60)
          write(sid, l)
          push(sid, { k: "doc", path: docRel })
          return
        }
        l.lastEditAt = Date.now()
        // Paths outside the repo, or under the OS temp dir, are scratch: probe
        // scripts and throwaway archives. Keeping them in `touched` made the
        // blast radius cover the whole working environment, so drift detection
        // could never fire, and it dragged unrelated paths into riskCats, which
        // is how a run floored at high on a temp copy of a .env.
        //
        // lastEditAt still advances for scratch. Invalidating a gate is the
        // conservative direction, and only riskCats and drift detection are
        // narrowed here.
        const abs = isAbsolute(p) ? p : resolve(root, p)
        const outsideRepo = relative(root, abs).startsWith("..") || p.startsWith(tmpdir())
        if (outsideRepo) {
          l.scratch = [...new Set([...l.scratch, p])].slice(-200)
          write(sid, l)
          // Push rather than return silently. A partition that is invisible in
          // the event stream is unobservable when it is wrong, and wrong in the
          // other direction means an edit escaping touched[] entirely.
          push(sid, { k: "scratch", path: p, test: TEST_PATH.test(p), ui: UI_EXT.test(p) })
          return
        }
        const isTest = TEST_PATH.test(p)
        if (isTest) {
          l.testEditsSinceGreen = [...new Set([...l.testEditsSinceGreen, p])].slice(-40)
          const body = contentArg(event.input)
          if (body && CHEAT_MARKERS.test(body)) {
            l.denials.push({ reason: `test-weakening marker in ${p}`, at: Date.now() })
            write(sid, l)
            push(sid, { k: "cheat", path: p })
            throw new Error(
              `loop-guard: blocked a test-weakening edit to ${p}.\n` +
                `Markers like test.skip / .only / .fixme / xfail make a gate go green without ` +
                `the behaviour existing. Fix the code, or state that the test is genuinely ` +
                `wrong and why. If you are certain, ask the user to record a waiver: ` +
                `/waive test-cheat <reason>`,
            )
          }
        }
        const isUi = UI_EXT.test(p)
        if (isUi) l.uiTouched = true
        l.touched = [...new Set([...l.touched, p])].slice(-200)
        write(sid, l)
        if (isTest || isUi) push(sid, { k: "edit", path: p, test: isTest, ui: isUi })
      } catch (err) {
        if (err instanceof Error && /loop-guard/.test(err.message)) throw err
      }
    },

    // The `todos` tool, registered in setup. V2 has no built-in todo tool, so
    // the plugin owns it; recording here keeps the ledger/portal contract.
    todosExecute: async (input: any, toolCtx: any) => {
      try {
        const sid = String(toolCtx?.sessionID ?? "")
        const todos = Array.isArray(input?.todos) ? input.todos : []
        if (!sid) return { content: `Todos not recorded (no session); ${todos.length} items received.` }
        const norm = todos.map((t: any) => `${t?.status ?? ""}~${t?.content ?? ""}`).join("|")
        const h = hash(norm)
        // The timestamp is stamped on EVERY call, not only on a content
        // change. The dedup exists so the portal is not spammed with events,
        // and reusing it here would report a list as abandoned the moment the
        // model re-read its own plan without editing it - the exact moment
        // staleness is a false positive.
        const touched = read(sid)
        touched.todoAt = Date.now()
        const changed = lastTodo.get(sid) !== h
        if (changed) {
          lastTodo.set(sid, h)
          // Persisted as well as emitted. The portal shows todos from events,
          // but compaction replaces the transcript, so a todo list that only
          // exists as events is a list the model cannot see after compaction.
          touched.todos = todos.slice(0, 60).map((t: any) => ({
            content: String(t?.content ?? "").slice(0, 200),
            status: String(t?.status ?? ""),
            priority: String(t?.priority ?? ""),
          }))
        }
        write(sid, touched)
        if (changed) push(sid, { k: "todo", todos: (touched.todos ?? []).map((t) => ({ c: t.content, s: t.status, p: t.priority })) })
        const open = (touched.todos ?? []).filter((t) => t.status === "in_progress").length
        return { content: `Todos updated (${todos.length} items${open ? `, ${open} in progress` : ""}).` }
      } catch (e: any) {
        return { content: `Todos not recorded: ${String(e?.message ?? e)}` }
      }
    },

    toolAfter: async (event: any) => {
      try {
        const sid = event.sessionID
        if (!sid) return
        beat(sid)
        if (event.tool !== "shell") return
        const rawCmd = cmdOf(event.input)
        if (!rawCmd) return
        const out = shellResult(event)

        // loopstage is matched on the RAW string, because the gate command is
        // resolved further below and this branch has to fire before anything else.
        // A wrapped `node loopgate.mjs -- node loopstage.mjs ...` is still a stage
        // command, and both forms contain the same word here, so nothing about
        // this branch depends on how the command is later resolved.
        if (/loopstage\.mjs/i.test(rawCmd)) {
          const raw = out.text.trim().split("\n").filter(Boolean).pop() ?? ""
          let d: any = null
          try {
            d = JSON.parse(raw)
          } catch {}
          if (d && d.verb && d.stage != null) {
            const verbOk = ["declare", "enter", "pass", "fail", "skip", "blocked", "note", "skills"].includes(String(d.verb))
            const stageOk = /^(10|[0-9]|5b)$/.test(String(d.stage))
            if (!verbOk || !stageOk) {
              push(sid, { k: "stage", stage: Number(d.stage) || -1, verb: "rejected", refused: `invalid stage/verb: ${d.stage}/${d.verb}`, note: "", skills: [] })
              return
            }
            const l = read(sid)
            const key = String(d.stage)
            const prev = l.stages[key] ?? { state: "", at: 0, note: "", skills: [] }
            if (typeof d.doc === "string" && d.doc.trim()) prev.doc = d.doc.trim().slice(0, 200)
            const floor = riskFloor(l, l.adapter)
            let verb = String(d.verb)
            let refused = ""
            if (verb === "skip" && [2, 6, 7].includes(Number(key)) && floor === "high") {
              verb = "blocked"
              refused = `skip of stage ${key} refused: risk floor is high (${riskCats(l).join(", ") || "adapter"})`
            }
            l.stages[key] = {
              state: verb,
              at: Date.now(),
              note: String(d.note ?? "").slice(0, 300),
              skills: Array.isArray(d.skills) ? d.skills.slice(0, 12).map(String) : prev.skills,
              ...(prev.doc ? { doc: prev.doc } : {}),
            }
            // The most recent enter/pass/fail note is the best available answer
            // to "what was I doing", which is the first thing lost on compaction.
            if (["enter", "pass", "fail", "blocked"].includes(verb)) l.nextAction = `stage ${key}: ${String(d.note ?? verb).slice(0, 160)}`
            if (d.verb === "declare" && d.risk) l.riskDeclared = String(d.risk)
            if (d.verb === "declare" && Array.isArray(d.files) && d.files.length) {
              l.declaredFiles = d.files.map(String).slice(0, 200)
              // Adapter selection happens here because the radius is only known
              // now, and it is the same event that declares the risk tier.
              const picked = autoSelect(l)
              if (picked) {
                l.adapter = picked.adapter
                l.autoAdapter = picked.why
              }
            }
            write(sid, l)
            push(sid, { k: "stage", stage: Number(key), verb, refused, note: l.stages[key].note, skills: l.stages[key].skills })
          }
          return
        }

        // ── THE COMMAND THAT RAN, TAKEN FROM THE REQUEST ─────────────────────
        //
        // `rawCmd` is `i.args.command`: the string the MODEL ASKED the tool to run.
        // It is the only statement about this run that the child cannot author,
        // and it is the same string `permission.ask` judged an instant earlier.
        // Both hooks resolve it the same way, with the same function, so a
        // permission decision and the recorded gate can never disagree about what
        // the command was.
        //
        // WHY IT IS NOT THE OUTPUT. The previous mechanism read the argv out of the
        // `[loopgate] EXEC` line in the child's own output and treated it as ground
        // truth. It was not: the child can type that line itself, and did. The whole
        // reader is deleted (section (a) above); `output` is now read only by
        // verdict(), for what the command PRINTED.
        //
        // WHAT IS LOST AND WHAT IS NOT. A wrapped gate in the grammar records the
        // inner command, so the ledger reads `npm test` rather than the wrapper's
        // own syntax -- a display string, and the same one the permission side saw.
        // A wrapped gate the grammar DECLINES is recorded whole, which still
        // classifies (classify() substring-matches `npm test` inside it), still
        // checks the exit code, still reaches isCompound(), and still cannot hide a
        // denial or a subset selector. No denial, narrowing or compoundness check
        // is lost in either branch.
        //
        // The exit code is trusted for a wrapped run too, which is correct rather
        // than weaker: loopgate.mjs mirrors its child's exit code exactly, which is
        // the property it exists to provide.
        const cmd = trivialCommand(rawCmd) ?? rawCmd
        const gate = classify(cmd)
        if (!gate) return

        const l = read(sid)
        // The wrapper's HEARTBEAT and EXEC lines are stripped HERE, on the way into
        // verdict() and nowhere else: not in loopgate.mjs, which must stay a dumb
        // wrapper, and not in the stored ledger output, which must stay the truth.
        // Its `--label` is model-authored, so a heartbeat must not be able to decide
        // a gate; its `argv` echoes the model's own `--grep` selector back, so on an
        // interrupted run it could decide one too. Both are removed, and neither is
        // read — see EXEC_LINE and stripWrapperLines above, and the note there on why
        // removal is not the parsing that was the CRITICAL.
        const v = verdict(cmd, stripWrapperLines({ output: out.text, metadata: { exitCode: out.exitCode } }))
        l.runs += 1
        const rec = {
          state: v,
          at: Math.max(Date.now(), l.lastEditAt + 1),
          command: cmd.slice(0, 300),
          detail:
            v === "unknown"
                ? "could not determine exit status — treated as not passing"
              : out.text
                ? out.text.slice(0, 300)
                : `exit ${v}`,
        }
        l.gates[gate] = rec
        // Count the failure shape so the "same error 3x -> stop" law survives
        // compaction, which destroys the transcript the count lived in.
        if (v === "fail") noteError(l, rec.detail)
        // One suite declared as both gates used to run twice per cycle. Dedupe is
        // driven by the adapter's own declaration rather than a guess: if this
        // exact command is declared under the other gate too, it is the same run
        // and it satisfies both. Coverage is unchanged — both gates hold, on one
        // piece of evidence, instead of two that could disagree.
        const other: GateName = gate === "code" ? "visual" : "code"
        const declaredOther = l.adapter.gates?.[other] ?? []
        const sameAsRecorded = l.gates[other].command !== "" && l.gates[other].command === rec.command
        const alsoDeclared = (declaredOther ?? []).some((c) => String(c).trim() === cmd.trim())
        if (sameAsRecorded || alsoDeclared) {
          l.gates[other] = { ...rec }
          push(sid, { k: "gate", gate: other, state: v, cmd: cmd.slice(0, 200), deduped: true })
        }
        if (v === "pass" && gate === "code") { l.testEditsSinceGreen = []; maybeFold(sid) }
        if (v === "pass" && gate === "code" && !l.stages?.["5"]) {
          // Advisory only. A free model that forgets one verb must not deadlock
          // the pipeline, so this is surfaced rather than enforced.
          push(sid, { k: "stage", stage: 5, verb: "unannounced", refused: "", note: "code gate passed with no stage 5 announcement", skills: [] })
        }
        write(sid, l)
        push(sid, { k: "gate", gate, state: v, cmd: cmd.slice(0, 200) })
      } catch {}
    },

    // V2: ctx.session.hook("prompt"), which runs once on prompt admission. Only
    // user prompts run it, which is exactly the goal/waiver source.
    promptHook: async (event: any) => {
      try {
        const sid = event.sessionID
        if (!sid) return
        ensurePortal()
        push(sid, { k: "msg" })
          if (!existsSync(ledgerPath(sid))) write(sid, blank(root, repoName, sid, getAdapter()))
        const text = typeof event?.prompt?.text === "string" ? event.prompt.text : ""
        const m = text.match(WAIVER_DIRECTIVE)
        if (!text) return
        // The goal lives only in the messages that start the run. Nothing else
        // records it, so once compaction rolls the transcript over it is simply
        // gone and the run continues towards something nobody wrote down.
        // Keyed on the field, not on the ledger file existing: the ledger is
        // created a line earlier, so an existence check never fires.
        const gl = read(sid)
        if (!gl.goal && text.trim()) {
          gl.goal = text.replace(/^\s*\/\S+\s*/, "").trim().slice(0, 400)
          write(sid, gl)
          push(sid, { k: "goal", text: gl.goal.slice(0, 160) })
        }
        if (!m) return
        const l = read(sid)
        l.waivers.push({ gate: m[1], reason: m[2].trim().slice(0, 300), at: Date.now() })
        write(sid, l)
        push(sid, { k: "waiver", gate: m[1], reason: m[2].trim().slice(0, 300) })
      } catch {}
    },

    // V2: ctx.session.hook("retry") fires once per provider failure, after
    // failure classification and before any retry is scheduled. That is the
    // closest replacement for V1's session.error watcher; the onEvent
    // subscription below also records terminal failures.
    retryHook: async (event: any) => {
      try {
        const cls = classifyLimit(event?.error)
        if (!cls) return
        const sid = String(event?.sessionID ?? "")
        const resetAt = resetAtOf(event?.error)
        const detail = `${event?.error?.type ?? event?.error?.name ?? "error"}: ${String(event?.error?.message ?? event?.error?.data?.message ?? "").slice(0, 200)}`
        noteLimit(sid, cls, detail, resetAt)
      } catch {}
    },

    // The plugin's event subscription. session.text.ended replaces V1's
    // experimental.text.complete (full text per completed part), and
    // session.compaction.ended replaces experimental.compaction.autocontinue.
    // Failure events feed the limit recorder as a backstop to the retry hook.
    // The event stream is server-wide, so anything carrying a location for
    // another project is ignored; this instance owns exactly one location.
    onEvent: (ev: any) => {
      try {
        const t = String(ev?.type ?? "")
        const d = ev?.data ?? {}
        const loc = ev?.location?.directory
        if (loc && resolve(String(loc)).toLowerCase() !== root.toLowerCase()) return

        if (t === "session.text.ended") {
          const sid = d.sessionID
          const text = typeof d.text === "string" ? d.text : ""
          if (!sid || !text) return
          const m =
            /VERDICT:\s*(ship|object|fix|block)/i.exec(text) ??
            /STATUS:\s*(done|blocked)/i.exec(text) ??
            /RESULT:\s*(pass|fail|unknown)/i.exec(text) ??
            /GATE:\s*(code|visual)\s*\nRESULT:\s*(pass|fail|unknown)/i.exec(text)
          if (!m) return
          const kind = m.length >= 3 ? m[1].toLowerCase() : ""
          const value = (m.length >= 3 ? m[2] : m[1]).toLowerCase()
          if (m.length >= 3) push(sid, { k: "verdict", kind, value })
          else push(sid, { k: "verdict", value })
          // A verdict is the only signal that says whether the run reached a
          // conclusion, and it is what commit gating reads. Without it on the
          // ledger there is no outcome to fold and nothing to calibrate against.
          const l = read(sid)
          l.outcome = value
          const last = l.nodes.at(-1)
          if (last && !last.outcome) last.outcome = value
          write(sid, l)
          return
        }

        if (t === "session.compaction.ended") {
          const sid = d.sessionID
          if (!sid) return
          const l = read(sid)
          l.compactions = (l.compactions ?? 0) + 1
          write(sid, l)
          push(sid, { k: "compacted", n: l.compactions })
          return
        }

        if (t === "session.retry.scheduled" || t === "session.execution.failed" || t === "session.step.failed") {
          const cls = classifyLimit(d.error)
          if (!cls) return
          const sid = String(d.sessionID ?? ev?.durable?.aggregateID ?? "")
          const resetAt = resetAtOf(d.error)
          const detail = `${d.error?.type ?? d.error?.name ?? "error"}: ${String(d.error?.message ?? "").slice(0, 200)}`
          noteLimit(sid, cls, detail, resetAt)
        }
      } catch {}
    },

    // V2: ctx.session.hook("compaction"). V1 appended to output.context, a
    // string array; V2's SystemPart carries the same carry block into the
    // summarisation request, and opencode still appends its own prompt.
    compactionHook: async (event: any) => {
      try {
        const sid = event?.sessionID
        if (!sid) return
        const l = read(sid)
        if (Array.isArray(event.system)) event.system.push({ type: "text", text: carryBlock(l) })
        l.carryAt = Date.now()
        write(sid, l)
        push(sid, { k: "compacting", stages: Object.keys(l.stages ?? {}).length, nodes: l.nodes.length })
      } catch {}
    },

    // V2: ctx.session.hook("context"), the per-request system transform for the
    // agent loop. V1's output.system was a string array; V2's SystemPart objects
    // carry the same block.
    contextHook: async (event: any) => {
      try {
        if (!Array.isArray(event?.system) || !event.sessionID) return
        // Loop-only block matter: the adapter hint and the ponytail mandate
        // are aimed at loop sessions, the ones that can act on them. If the
        // runtime cannot report the agent, show them anyway: a hint nobody
        // sees is a feature that does not exist.
        const ag = String(event?.agent ?? "")
        const loopAgent = !ag || /^loop(-|$)/.test(ag)
        event.system.push({ type: "text", text: systemBlock(read(event.sessionID), loopAgent) })
      } catch {}
    },
  }

  return handlers
}

export default {
  id: "loop-guard",
  async setup(ctx: any) {
    let inner: any = null
    try {
      inner = await __guardFactory(ctx)
    } catch (e: any) {
      // Loud on stderr, inert in the hook path. Never silently unguarded.
      try {
        process.stderr.write(`[loop-guard] FAILED TO SETUP, running inert: ${String(e?.stack ?? e)}\n`)
      } catch {}
      return
    }
    if (!inner) return

    const regs: Array<{ dispose?: () => Promise<void> | void }> = []
    const reg = async (make: () => any) => {
      try {
        const r = await make()
        if (r) regs.push(r)
      } catch (e: any) {
        try {
          process.stderr.write(`[loop-guard] hook registration failed: ${String(e?.message ?? e)}\n`)
        } catch {}
      }
    }
    await reg(() => ctx.permission.hook("evaluate", inner.permissionEvaluate))
    await reg(() => ctx.tool.hook("execute.before", inner.toolBefore))
    await reg(() => ctx.tool.hook("execute.after", inner.toolAfter))
    await reg(() => ctx.session.hook("prompt", inner.promptHook))
    await reg(() => ctx.session.hook("retry", inner.retryHook))
    await reg(() => ctx.session.hook("context", inner.contextHook))
    await reg(() => ctx.session.hook("compaction", inner.compactionHook))

    // V2 removed the built-in todo tool. The plugin re-provides it as `todos`;
    // codemode: false keeps it in the model's native tool list instead of
    // hiding it behind the Code Mode execute tool.
    try {
      await ctx.tool.transform((editor: any) => {
        editor.add({
          name: "todos",
          description:
            "Create and manage the structured task list for this run. Each call replaces the whole list. Keep exactly one item in_progress at a time; the loop portal renders this list, and it is how a human watches an unattended run.",
          input: {
            type: "object",
            properties: {
              todos: {
                type: "array",
                description: "The full todo list for this run, in order.",
                items: {
                  type: "object",
                  properties: {
                    content: { type: "string", description: "Short description of the task." },
                    status: { type: "string", enum: ["pending", "in_progress", "completed", "cancelled"] },
                    priority: { type: "string", enum: ["high", "medium", "low"] },
                  },
                  required: ["content", "status"],
                },
              },
            },
            required: ["todos"],
            additionalProperties: false,
          },
          options: { codemode: false },
          execute: (input: any, toolCtx: any) => inner.todosExecute(input, toolCtx),
        })
      })
    } catch (e: any) {
      try {
        process.stderr.write(`[loop-guard] todos tool registration failed: ${String(e?.message ?? e)}\n`)
      } catch {}
    }

    const ac = new AbortController()
    void (async () => {
      try {
        for await (const ev of ctx.event.subscribe({ signal: ac.signal })) {
          try {
            inner.onEvent(ev)
          } catch {}
        }
      } catch {}
    })()

    return async () => {
      try {
        ac.abort()
      } catch {}
      for (const r of regs.reverse()) {
        try {
          await r.dispose?.()
        } catch {}
      }
      try {
        await inner.cleanup()
      } catch {}
    }
  },
}
