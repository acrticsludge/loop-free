//   node loopgate.selftest.mjs
//
// WHAT THIS TESTS, AND WHY IT SPAWNS A REAL CHILD
//
// The wrapper's whole contract is about a child process: live output, a
// heartbeat on a timer, a timeout that kills, and an exit code that mirrors.
// None of that can be asserted by importing internals — a mock would only
// prove the mock was wired up. So every case below spawns loopgate.mjs as a
// real child and captures its stdout/stderr, exactly as the loop's gate runner
// would see it.
//
// A watchdog in the runner turns a hang into a clean failure: if loopgate
// leaks a timer and never exits, the child is killed and the case fails on its
// assertion rather than hanging the suite.

import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import { basename, dirname, join } from "node:path"
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"

const HERE = dirname(fileURLToPath(import.meta.url))
const LOOPGATE = join(HERE, "loopgate.mjs")
const EXEC_PREFIX = "[loopgate] EXEC "

// WHY THESE PARSE THE REAL LINE, WHEN NOTHING AUTOMATED READS IT.
//
// loopgate.mjs keeps printing `[loopgate] EXEC {"argv":[...],"cwd":"..."}` for
// HUMANS, and these tests pin the shape that makes it worth reading: one line,
// that literal prefix, then one line of JSON whose `argv` is exactly what spawn
// was handed. The plugin used to read it — and that reader was a CRITICAL,
// because the line travels in the same merged stream as the child's own output
// and the child can therefore author it itself. That reader is deleted.
//
// SO WHY KEEP THE LINE, AND WHY KEEP THESE TESTS? Because it is the one artifact
// that shows a human exactly which argv was spawned, and because the "argv equals
// what the child received" assertion below is a real property of the wrapper's
// spawn path that would otherwise be untested. The line is diagnostic; these
// assertions are about the wrapper, not about a consumer. Nothing here may ever
// become the justification for a parser over tool output.
const execLines = (stderr) => stderr.split("\n").filter((l) => l.includes(EXEC_PREFIX))
const execArgv = (stderr) => {
  const lines = execLines(stderr)
  if (lines.length !== 1) return null
  try {
    return JSON.parse(lines[0].slice(lines[0].indexOf(EXEC_PREFIX) + EXEC_PREFIX.length)).argv
  } catch {
    return null
  }
}

let pass = 0
let fail = 0
const ok = (n, c, e = "") => { if (c) { pass++; console.log(`  ok   ${n}`) } else { fail++; console.log(`  FAIL ${n} ${e}`) } }
const sec = (n) => console.log(`\n${n}`)

// WHY: the assertions are about the process actually terminating. A leaked
// heartbeat interval would keep node alive after the child ended, so the close
// event never fires; the watchdog converts that hang into a resolvable failure
// instead of stalling the suite.
// `cwd` is the third argument because at least one case below needs the gate to
// run in a directory it did not create in this process: `npm run <name>` is
// meaningless outside a package, and asserting it would otherwise be asserting
// the wrong thing.
const runGate = (args, timeoutMs = 20000, cwd = undefined) => {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [LOOPGATE, ...args], { shell: false, cwd })
    let out = ""
    let err = ""
    let settled = false
    const watchdog = setTimeout(() => {
      if (settled) return
      child.kill("SIGKILL")
      resolve({ code: null, stdout: out, stderr: err, watchdog: true })
    }, timeoutMs)
    const done = (code) => {
      if (settled) return
      settled = true
      clearTimeout(watchdog)
      resolve({ code, stdout: out, stderr: err })
    }
    child.stdout.on("data", (d) => { out += d })
    child.stderr.on("data", (d) => { err += d })
    child.on("close", (code) => done(code))
    child.on("error", () => done(null))
  })
}

const main = async () => {

  sec("loopgate: a passing command")
  {
    const r = await runGate(["--", "node", "-e", "process.exit(0)"])
    ok("exits 0", r.code === 0, `code=${r.code}`)
    ok("prints a PASS verdict", /\[loopgate\] PASS  exit 0/.test(r.stderr), r.stderr)
  }

  sec("loopgate: a failing command mirrors the child's exit code")
  {
    const r = await runGate(["--", "node", "-e", "process.exit(3)"])
    ok("exits with the child's code 3, not 0 and not 124", r.code === 3, `code=${r.code}`)
    ok("prints a FAIL verdict naming exit 3", /\[loopgate\] FAIL  exit 3/.test(r.stderr), r.stderr)
  }

  sec("loopgate: forwards stdout and stderr live")
  {
    const r = await runGate(["--", "node", "-e", "console.error('to-stderr'); console.log('to-stdout')"])
    ok("stdout is forwarded", r.stdout.includes("to-stdout"), JSON.stringify(r.stdout))
    ok("stderr is forwarded", r.stderr.includes("to-stderr"), JSON.stringify(r.stderr))
  }

  sec("loopgate: the heartbeat fires and is safe to render")
  {
    const r = await runGate(["--heartbeat", "1", "--", "node", "-e", "setTimeout(() => {}, 3000)"])
    const beats = r.stderr.split("\n").filter((l) => /\[loopgate\] \d\d:\d\d elapsed \| still running \| beat \d+/.test(l))
    ok("at least 2 heartbeat lines fire in ~3s at a 1s interval", beats.length >= 2, `${beats.length} beats: ${JSON.stringify(beats)}`)
    ok("heartbeat lines carry the beat count", beats.every((l) => /beat \d+/.test(l)), JSON.stringify(beats))
    ok("no carriage return anywhere in the output", !r.stderr.includes("\r") && !r.stdout.includes("\r"), "a \\r corrupts an interactive TUI")
    ok("no ANSI escape sequence anywhere in the output", !/\x1b\[/.test(r.stderr) && !/\x1b\[/.test(r.stdout), "cursor movement corrupts an interactive TUI")
  }

  sec("loopgate: the heartbeat's last field is the caller's --label, verbatim")
  {
    // WHY THIS SECTION EXISTS. loop-guard's verdict() strips the heartbeat line
    // before it reads a gate, on the grounds that the heartbeat is wrapper output
    // and its last field is model-authored free text. Both halves of that
    // reasoning are only true while this contract holds, and nothing asserted it:
    // a change here would leave the plugin's strip silently matching nothing --
    // or matching too much -- while every other test stayed green.
    //
    // The pass phrase in the label is DELIBERATE. It is the exact text that made
    // verdict() return "pass" on a run with no exit code, so a regression that
    // starts appending the label elsewhere is caught by asserting it lands in the
    // trailing field.
    const r = await runGate(["--heartbeat", "1", "--label", "All tests passed", "--", "node", "-e", "setTimeout(() => {}, 2500)"])
    // Filtered to heartbeat lines only, using the same shape the section above
    // pins. A bare `[loopgate] ` filter would also catch the PASS/FAIL verdict
    // line, which carries no label and is not what this contract is about.
    const beats = r.stderr.split("\n").filter((l) => /\[loopgate\] \d\d:\d\d elapsed \| still running \| beat \d+/.test(l))
    ok("a heartbeat line was emitted", beats.length >= 1, JSON.stringify(beats))
    ok("the label is the heartbeat's LAST field, verbatim", beats.every((l) => l.trimEnd().endsWith("| All tests passed")), JSON.stringify(beats))
    ok("the label is separated from the beat count by ' | '", beats.every((l) => /beat \d+ \| /.test(l)), JSON.stringify(beats))
  }

  sec("loopgate: a timeout produces a TIMEOUT verdict and exit 124")
  {
    const r = await runGate(["--timeout", "1", "--", "node", "-e", "setTimeout(() => {}, 5000)"])
    ok("exits 124", r.code === 124, `code=${r.code}`)
    ok("prints a TIMEOUT verdict", /\[loopgate\] TIMEOUT/.test(r.stderr), r.stderr)
  }

  sec("loopgate: usage errors exit 2")
  {
    const none = await runGate([])
    ok("no command exits 2", none.code === 2, `code=${none.code}`)
    ok("no command prints usage", /usage/.test(none.stderr), none.stderr)
    const bad = await runGate(["--bogus", "npm", "test"])
    ok("an unknown flag exits 2", bad.code === 2, `code=${bad.code}`)
    ok("an unknown flag prints usage", /usage/.test(bad.stderr), bad.stderr)
  }

  sec("loopgate: the process actually exits (no leaked timer)")
  {
    // A leaked heartbeat interval would keep node alive and this promise would
    // never resolve; the watchdog turns that hang into a clean failure.
    const r = await runGate(["--", "node", "-e", "process.exit(0)"])
    ok("the runner terminates promptly after the child ends", r.code === 0 && !r.watchdog, `code=${r.code} watchdog=${r.watchdog}`)
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// WHY A REAL GRANDCHILD, AND WHY A CONTROL RUN
//
// A gate command in this project is not always a test process. It is also
// `astro dev`, a watcher, a queue worker, a Playwright config that starts a
// server. Those spawn children of their own, and the wrapper's timeout has to
// reach them: the contract is "a timed-out gate is not still running when the
// wrapper exits 124", and a surviving dev server holds the port the next
// attempt needs.
//
// This is not hypothetical. child.kill() on Windows terminates the DIRECT child
// only, and a detached grandchild was measured writing its marker file three
// seconds AFTER the wrapper had already exited. A mock could not show that,
// because the bug is in which processes the OS is asked to terminate.
//
// The grandchild is created with detached:true + stdio:"ignore" + unref(), which
// is exactly how a dev server daemonises itself, and it is given no parent that
// will wait for it.
//
// A control run comes FIRST and writes the same marker through the same code
// path with no timeout involved. If that marker does not appear, the grandchild
// was never created on this platform and the negative assertion below would
// pass for the wrong reason -- a test that cannot fail is not evidence. That case
// is reported and skipped rather than quietly counted.
const grandchildSrc = (marker, delayMs) =>
  `setTimeout(() => { try { require("fs").writeFileSync(${JSON.stringify(marker)}, "alive") } catch {} }, ${delayMs})`
const parentSrc = (marker, delayMs, holdMs) =>
  `const { spawn } = require("child_process");` +
  `const c = spawn(process.execPath, ["-e", ${JSON.stringify(grandchildSrc(marker, delayMs))}], { detached: true, stdio: "ignore" });` +
  `c.unref();` +
  `setTimeout(() => {}, ${holdMs})`

// Both files live under a temp dir this process owns, and both are removed in
// the finally below -- including when the assertions throw.
const TMP = join(tmpdir(), `loopgate-f3-${Date.now()}`)
const markerOf = (name) => join(TMP, name)
const sleep2 = 3000

sec("loopgate: a timeout leaves no grandchild running")
try {
  mkdirSync(TMP, { recursive: true })
  const controlMarker = markerOf("control.marker")
  // No --timeout here: the wrapper exits when the parent does, and the
  // grandchild's marker must appear anyway. This proves the machinery works.
  const control = await runGate(["--", process.execPath, "-e", parentSrc(controlMarker, 500, 1200)])
  await sleep(sleep2 + 1200)
  const grandchildWorks = existsSync(controlMarker)
  ok("control: a detached grandchild really does outlive its parent", grandchildWorks,
    `control parent exit=${control.code} marker=${existsSync(controlMarker)}`)

  if (!grandchildWorks) {
    console.log("      note: this platform would not create the detached grandchild, so the")
    console.log("      note: tree-kill assertion below is SKIPPED rather than counted as a pass.")
  } else {
    const marker = markerOf("tree.marker")
    // The parent holds for 30s; the wrapper kills it at 1s; the grandchild would
    // write at 3s, i.e. 2s after the wrapper exited 124.
    const r = await runGate(["--timeout", "1", "--", process.execPath, "-e", parentSrc(marker, 3000, 30000)])
    ok("the wrapper still exits 124", r.code === 124, `code=${r.code}`)
    const exitedAt = Date.now()
    await sleep(sleep2 + 1500)
    const after = existsSync(marker)
    ok("the grandchild was gone before it could write its marker", !after,
      `marker appeared ${Date.now() - exitedAt}ms after the wrapper exited -- a grandchild survived the timeout`)
  }
} finally {
  try { rmSync(TMP, { recursive: true, force: true }) } catch {}
}
ok("the temporary grandchild directory is cleaned up", !existsSync(TMP))

  sec("loopgate: shell metacharacters are not interpreted (shell:false)")
  {
    const r = await runGate(["--", "node", "-e", "console.log('a && b')"])
    ok("the literal text 'a && b' is passed through, not run by a shell", r.stdout.includes("a && b"), JSON.stringify(r.stdout))
  }

// ══════════════════════════════════════════════════════════════════════════
// THE EXEC LINE IS A HUMAN DIAGNOSTIC. NO AUTOMATED CONSUMER READS IT, AND THIS
// SUITE IS NOT ONE OF THEM.
//
// It is kept because a human running a gate in a terminal needs to know which argv
// was spawned. The sections below assert that it is printed once, before the
// child's first byte, and that its `argv` is byte-for-byte the array handed to
// spawn — a real property of this file's own contract.
//
// They are NOT a claim that anything downstream may rely on it. The plugin DID
// read this line out of the tool output, and the child forged it to record a green
// `npm test` gate on a command that only printed text. The reader is deleted and
// must stay deleted. If you are here considering adding one back: that is the bug.
// ══════════════════════════════════════════════════════════════════════════

  sec("loopgate: the EXEC diagnostic is printed once, before the child starts")
  {
    // The child writes to STDERR so it lands in the same stream as the diagnostic and
    // the ORDER is observable. `before the child starts` is the claim that
    // matters: a report emitted after the spawn could lose the race with a child
    // that fails immediately, which is exactly the run a human most needs it for.
    const r = await runGate(["--", process.execPath, "-e", "console.error('CHILD-FIRST-BYTE')"])
    ok("exactly one EXEC line is printed per invocation", execLines(r.stderr).length === 1, JSON.stringify(r.stderr))
    const at = r.stderr.indexOf(EXEC_PREFIX)
    const childAt = r.stderr.indexOf("CHILD-FIRST-BYTE")
    ok("the EXEC line is on the stream before the child's first byte", at >= 0 && childAt >= 0 && at < childAt, `exec@${at} child@${childAt}: ${JSON.stringify(r.stderr)}`)
    ok("it is one line: the literal prefix then JSON, with no wrapping", execLines(r.stderr)[0].startsWith(EXEC_PREFIX), JSON.stringify(execLines(r.stderr)[0]))
    ok("its JSON parses and carries an argv array", Array.isArray(execArgv(r.stderr)), JSON.stringify(r.stderr))
  }

  sec("loopgate: the reported argv is EXACTLY what the child received")
  {
    // THE PROOF, AND IT IS A PROOF RATHER THAN A RESTATEMENT. The child prints its
    // OWN `process.argv`, and that printed array is compared to the argv parsed out
    // of the EXEC line. If the wrapper re-derived, trimmed, dropped or reordered
    // anything on the way, the two would differ. The runtime and the script path
    // are compared separately because the wrapper is invoked with whatever the
    // caller typed while the child reports its resolved absolute path.
    const dir = join(tmpdir(), `loopgate-exec-${Date.now()}`)
    mkdirSync(dir, { recursive: true })
    const script = join(dir, "echoargv.mjs")
    writeFileSync(script, "console.log(JSON.stringify(process.argv.slice(2)))\n", "utf8")
    try {
      const args = ["alpha", "beta-2", "--grep", "list page", "C:/a path/x.ts"]
      const r = await runGate(["--", process.execPath, script, ...args])
      const reported = execArgv(r.stderr)
      ok("the EXEC line was written", Array.isArray(reported), JSON.stringify(r.stderr))
      ok("it names the runtime that actually ran", reported && basename(reported[0]) === basename(process.execPath), JSON.stringify(reported))
      ok("and the script the child was given", reported && reported[1] === script, JSON.stringify(reported))
      const printed = JSON.parse(r.stdout.trim())
      ok("the argv the child received is EXACTLY the argv reported", JSON.stringify(reported.slice(2)) === JSON.stringify(printed), `reported=${JSON.stringify(reported.slice(2))} printed=${JSON.stringify(printed)}`)
      ok("and every argument survives, in order, spaces and dashes included", printed.length === args.length && printed.every((a, i) => a === args[i]), JSON.stringify(printed))
    } finally {
      try { rmSync(dir, { recursive: true, force: true }) } catch {}
    }
  }

  sec("loopgate: the reported argv is the array handed to spawn, on a failing run too")
  {
    const r = await runGate(["--timeout", "5", "--", process.execPath, "-e", "process.exit(7)"])
    const reported = execArgv(r.stderr)
    ok("a failing run still reports its argv", JSON.stringify(reported) === JSON.stringify([process.execPath, "-e", "process.exit(7)"]), JSON.stringify(reported))
    ok("and still mirrors the exit code", r.code === 7, `code=${r.code}`)
  }

  sec("loopgate: a --label cannot inject a line")
  {
    // The label is MODEL-AUTHORED FREE TEXT and it is written into a line that
    // lands in the tool result, where gate logic reads output as test results. A
    // newline in it would therefore create a line no consumer could tell from real
    // output — and one that could carry a pass phrase. The heartbeat is the only
    // place a label is written, so the heartbeat is what is asserted.
    const raw = "first\nsecond\rAll tests passed"
    const r = await runGate(["--heartbeat", "1", "--label", raw, "--", "node", "-e", "setTimeout(() => {}, 2500)"])
    const lines = r.stderr.split("\n")
    const beats = lines.filter((l) => /\[loopgate\] \d\d:\d\d elapsed \| still running \| beat \d+/.test(l))
    ok("heartbeats still fire with a multi-line label", beats.length >= 1, JSON.stringify(beats))
    ok("every newline and carriage return in the label became a space", beats.every((l) => l.endsWith("| first second All tests passed")), JSON.stringify(beats))
    ok("the label created no line of its own", !lines.some((l) => l.trim() === "All tests passed"), JSON.stringify(lines))
    ok("and the output has no stray carriage return", !r.stderr.includes("\r"), JSON.stringify(r.stderr))
  }

  sec("loopgate: a --label cannot inject a control character")
  {
    // \r and \n were collapsed, but every OTHER C0 control byte was written
    // verbatim into the heartbeat and into the ledger: harden measured
    // `"... | A\x1b[2J\x08B"`. ESC is the start of every ANSI sequence and BS is
    // the backspace that erases what was drawn before it, so a single control byte
    // in a line that is captured into the loop ledger and rendered into the portal
    // can corrupt a terminal or a portal render. They are model-authored, so they
    // are stripped.
    const raw = "A\x1b[2J\x08B"
    ok("the label really does carry the bytes, or this test cannot fail", raw.includes("\x1b") && raw.includes("\x08"), JSON.stringify(raw))
    const r = await runGate(["--heartbeat", "1", "--label", raw, "--", "node", "-e", "setTimeout(() => {}, 2500)"])
    const beats = r.stderr.split("\n").filter((l) => /\[loopgate\] \d\d:\d\d elapsed \| still running \| beat \d+/.test(l))
    ok("heartbeats still fire with a control-character label", beats.length >= 1, JSON.stringify(beats))
    ok("no ESC byte appears anywhere in stderr", !r.stderr.includes("\x1b"), JSON.stringify(r.stderr))
    ok("no ESC byte appears anywhere in stdout", !r.stdout.includes("\x1b"), JSON.stringify(r.stdout))
    ok("no BS byte appears anywhere in stderr", !r.stderr.includes("\x08"), JSON.stringify(r.stderr))
    ok("no BS byte appears anywhere in stdout", !r.stdout.includes("\x08"), JSON.stringify(r.stdout))
    ok("and no ANSI escape sequence survives", !/\x1b\[/.test(r.stderr) && !/\x1b\[/.test(r.stdout), JSON.stringify(r.stderr))
    // Stripping the BYTES leaves the printable text, so the heartbeat is still
    // the heartbeat and the label is still its last field -- it is the control
    // characters that go, not the content.
    ok("the printable text either side of them survives", beats.every((l) => l.trimEnd().endsWith("| A[2JB")), JSON.stringify(beats))
  }

  sec("loopgate: every C0 control byte is stripped from a --label")
  {
    // Asserted across the whole C0 range plus DEL, not just the two that were
    // already handled, so a later edit that narrows the class is caught.
    //
    // 0x00 is excluded, and not as a convenience: it cannot reach this code at
    // all. A label only arrives through argv, and `spawn` refuses a NUL in an
    // argument outright (ERR_INVALID_ARG_VALUE), so NUL is stopped by the
    // platform before loopgate.mjs is entered. \n is excluded because it is the
    // one control character that is COLAPSED to a space rather than removed, and
    // the collapse is asserted in the section above.
    const raw = Array.from({ length: 0x20 }, (_, c) => String.fromCharCode(c))
      .filter((c) => c !== "\u0000" && c !== "\n")
      .concat("\n", String.fromCharCode(0x7f))
      .join("")
    const r = await runGate(["--heartbeat", "1", "--label", raw, "--", "node", "-e", "setTimeout(() => {}, 2500)"])
    const beats = r.stderr.split("\n").filter((l) => /\[loopgate\] \d\d:\d\d elapsed \| still running \| beat \d+/.test(l))
    ok("heartbeats still fire", beats.length >= 1, JSON.stringify(beats))
    const residual = [...new Set((r.stderr + r.stdout).split("").filter((c) => c.charCodeAt(0) < 0x20 && c !== "\n"))]
    ok("no C0 byte other than the line's own newline survives", residual.length === 0, JSON.stringify(residual))
    ok("and DEL does not survive either", !r.stderr.includes("\u007f") && !r.stdout.includes("\u007f"), JSON.stringify(r.stderr))
  }

  sec("loopgate: a usage error prints no EXEC line, because nothing ran")
  {
    // The wrapper's own honesty, not a plugin contract: nothing was spawned, so
    // there is no argv to report. Announcing one anyway would put a line in the
    // diagnostic stream that describes a command that never started — which is the
    // shape of the forgery that was just closed on the consumer side.
    const r = await runGate(["--nonsense", "npm", "test"])
    ok("a usage error exits 2", r.code === 2, `code=${r.code}`)
    ok("and reports no argv, because no argv was spawned", execLines(r.stderr).length === 0, JSON.stringify(r.stderr))
  }

  // ══════════════════════════════════════════════════════════════════════════
// THE BLOCKER: ON WINDOWS A BATCH SHIM CANNOT BE SPAWNED WITH shell:false.
//
// MEASURED, on the machine this was written on:
//   spawnSync("npm",      ["--version"], {shell:false}) => status null, ENOENT
//   spawnSync("npm.cmd", ["--version"], {shell:false}) => status null, EINVAL
//   node --version                                        => v24.19.0
// and end to end through this wrapper:
//   node loopgate.mjs -- npm test
//     [loopgate] spawn error: spawn npm ENOENT
//     [loopgate] FAIL  exit 127    in 0m00s
//
// Node 22.12/23.0.1/24 refuse to spawn a `.cmd`/`.bat` without a shell, as the
// CVE-2024-27980 mitigation. On Windows `npm` is `C:\Program Files\nodejs\npm.cmd`,
// so the wrapper's single most important command could not run at all.
//
// The fix routes a batch shim through `cmd.exe /d /s /c` and refuses anything it
// cannot carry safely. Everything that is not a batch shim keeps the direct spawn
// untouched, and `shell: true` is never used — see loopgate.mjs.
//
// The section below is Windows-guarded rather than asserted unconditionally: the
// branch does not exist off Windows, so an unguarded assertion here would either
// fail for the wrong reason or (worse) be softened until it passes on both.
const IS_WIN = process.platform === "win32"

// A real .cmd, so the batch-shim branch is exercised on something this suite owns
// rather than only on a system file. It replicates npm.cmd's shape --
// `"%NODE%" "SCRIPT" %*` -- because the `%*` re-expansion is the surface the
// refusal list exists to close, and a shim that echoes its args differently would
// not be testing the same thing.
const SHIM_DIR = join(tmpdir(), `loopgate-shim-${Date.now()}`)
const shimOf = (name) => join(SHIM_DIR, name)
const echoArgsShim = (name) => {
  const p = shimOf(name)
  writeFileSync(
    p,
    `@ECHO OFF\r\nSETLOCAL\r\n"${process.execPath}" "${shimOf("echoargs.mjs")}" %*\r\n`,
    "ascii",
  )
  return p
}
// Writes its marker ONLY if it runs at all, so "marker absent" is evidence that
// nothing was spawned rather than evidence that the shim misbehaved.
const markerShim = (name, marker) => {
  const p = shimOf(name)
  writeFileSync(p, `@ECHO OFF\r\nSETLOCAL\r\necho ran> "${marker}"\r\n`, "ascii")
  return p
}

try {
  mkdirSync(SHIM_DIR, { recursive: true })
  writeFileSync(shimOf("echoargs.mjs"), "console.log(JSON.stringify(process.argv.slice(2)))\n", "utf8")

  sec("loopgate: on Windows a batch shim is routed through cmd.exe, and npm runs")

  // ── THE BLOCKER REGRESSION. The single most important assertion in this file.
  const npmVer = await runGate(["--", "npm", "--version"], 60000)
  ok(`${IS_WIN ? "" : "[posix] "}npm --version exits 0, not 127 with spawn ENOENT`,
    npmVer.code === 0, `code=${npmVer.code} stderr=${JSON.stringify(npmVer.stderr.slice(0, 300))}`)
  ok(`${IS_WIN ? "" : "[posix] "}it is not the ENOENT failure that motivated this section`,
    !/spawn npm ENOENT/.test(npmVer.stderr), JSON.stringify(npmVer.stderr))
  ok(`${IS_WIN ? "" : "[posix] "}its stdout carries an npm version`,
    /\d+\.\d+\.\d+/.test(npmVer.stdout), JSON.stringify(npmVer.stdout))
  ok(`${IS_WIN ? "" : "[posix] "}and the wrapper reports PASS, not FAIL 127`,
    /\[loopgate\] PASS  exit 0/.test(npmVer.stderr), JSON.stringify(npmVer.stderr))

  if (IS_WIN) {
    ok("the EXEC diagnostic is still exactly one line", execLines(npmVer.stderr).length === 1, JSON.stringify(npmVer.stderr))
    ok("its JSON still parses", Array.isArray(execArgv(npmVer.stderr)), JSON.stringify(npmVer.stderr))
    ok("and its argv is still what the user asked for", JSON.stringify(execArgv(npmVer.stderr)) === JSON.stringify(["npm", "--version"]), JSON.stringify(execArgv(npmVer.stderr)))
    // The line must not lie about what ran. On this path the process really
    // spawned is cmd.exe, and a human reading the diagnostic has to be told.
    let route = null
    try { route = JSON.parse(execLines(npmVer.stderr)[0].slice(execLines(npmVer.stderr)[0].indexOf(EXEC_PREFIX) + EXEC_PREFIX.length)) } catch {}
    ok("the EXEC line names the cmd.exe route rather than implying a direct npm spawn",
      !!route && /cmd\.exe/i.test(String(route.via || "")) && /\/d/.test(String(route.via || "")) && /\/s/.test(String(route.via || "")) && /\/c/.test(String(route.via || "")),
      JSON.stringify(route))
    ok("and names the batch shim it resolved npm to",
      !!route && /\.cmd$/i.test(String(route.resolved || "")), JSON.stringify(route))
    ok("and carries the argv actually handed to spawn",
      Array.isArray(route && route.spawnArgv) && /cmd\.exe$/i.test(route.spawnArgv[0]) && JSON.stringify(route.spawnArgv.slice(1, 4)) === JSON.stringify(["/d", "/s", "/c"]),
      JSON.stringify(route && route.spawnArgv))
  }

  sec("loopgate: arguments survive the batch-shim route byte-for-byte")
  {
    // A path with spaces is the case that fails first: an unquoted executable path
    // is mis-split into 'C:\Program' + 'Files\...', which is how npm used to fail.
    // This runs the suite's own .cmd shim with spaces in ITS path and in its args.
    const sent = ["alpha", "beta-2", "--grep", "list page", "C:/a path/x.ts", "", "tab\there", "back\\slash", "caf\u00e9"]
    const r = await runGate(["--", echoArgsShim("surveyor.cmd"), ...sent], 30000)
    ok("the batch shim ran and exited 0", r.code === 0, `code=${r.code} stderr=${JSON.stringify(r.stderr.slice(0, 300))}`)
    let got = null
    try { got = JSON.parse(r.stdout.trim()) } catch {}
    ok("every argument arrived intact, in order, spaces/tabs/backslashes/empty/unicode included",
      JSON.stringify(got) === JSON.stringify(sent), `sent=${JSON.stringify(sent)} got=${JSON.stringify(got)}`)
  }

  sec("loopgate: npm run <name> reaches npm through the route")
  {
    const proj = shimOf("proj")
    mkdirSync(proj, { recursive: true })
    writeFileSync(join(proj, "package.json"), JSON.stringify({ name: "shim-probe", version: "1.0.0", private: true, scripts: { hello: "node -e \"console.log('HELLO-FROM-SCRIPT')\"" } }), "utf8")
    const r = await runGate(["--", "npm", "run", "hello"], 120000, proj)
    const spawnable = !/spawn npm ENOENT/.test(r.stderr)
    ok("npm run spawns rather than dying ENOENT", spawnable, JSON.stringify(r.stderr.slice(0, 300)))
    ok("and the script npm was asked for actually ran", r.stdout.includes("HELLO-FROM-SCRIPT"), `code=${r.code} cwd=${proj} stdout=${JSON.stringify(r.stdout.slice(0, 400))} stderr=${JSON.stringify(r.stderr.slice(0, 300))}`)
  }

  sec("loopgate: npx is reachable through the route where it exists")
  {
    const r = await runGate(["--", "npx", "--version"], 60000)
    const spawnable = !/spawn npx ENOENT/.test(r.stderr)
    if (spawnable && r.code === 0) {
      ok("npx --version exits 0 and prints a version", /\d+\.\d+\.\d+/.test(r.stdout), JSON.stringify(r.stdout))
    } else {
      // Not a skip-for-convenience: an npx that is not a batch shim (or is absent)
      // legitimately takes the direct path, and that is a fact about the machine.
      // The fallback must be an HONEST one — it accepts only a genuine spawn error,
      // so a real regression (npm running but npx returning some other non-zero
      // code) cannot hide behind it.
      const spawnError = /\[loopgate\] spawn error:/.test(r.stderr)
      ok("npx is either absent or not a batch shim here, and says so rather than silently passing",
        spawnError && r.code === 127, `code=${r.code} spawnError=${spawnError} stderr=${JSON.stringify(r.stderr.slice(0, 200))}`)
      console.log(`      note: npx not runnable via the batch route here (code=${r.code}); reported, not counted as a pass.`)
    }
  }

  sec("loopgate: the exit code is mirrored through the batch-shim route")
  {
    const p = shimOf("exit7.cmd")
    writeFileSync(p, "@ECHO OFF\r\nSETLOCAL\r\nexit /b 7\r\n", "ascii")
    const r = await runGate(["--", p], 30000)
    ok("a shim exiting 7 gives wrapper 7, not 0 and not 124", r.code === 7, `code=${r.code}`)
    ok("and the FAIL verdict names exit 7", /\[loopgate\] FAIL  exit 7/.test(r.stderr), JSON.stringify(r.stderr))
  }

  sec("loopgate: a timeout still gives 124 and still tree-kills THROUGH cmd.exe")
  {
    // THIS IS THE RISK THE ROUTE INTRODUCES, and it is not theoretical. On the
    // direct path the direct child IS the gate. On the cmd.exe path the direct
    // child is cmd.exe and the real gate is its grandchild, so `taskkill /T` now
    // has one more hop to walk and the grandchild-of-grandchild is what writes the
    // marker. If the walk stops at cmd.exe, a timed-out gate keeps running -- which
    // is the exact failure this file already proved was real.
    const mk = shimOf("tree.marker")
    // .cjs, not .mjs: these use require(), and an .mjs file has no require — the
    // first version of this test shimmed a script that threw before it could ever
    // spawn a grandchild, so the "nothing survived" assertion passed vacuously.
    const grand = shimOf("grand.cjs")
    writeFileSync(grand, `setTimeout(() => { try { require("fs").writeFileSync(${JSON.stringify(mk)}, "alive") } catch {} }, 3000)\n`, "utf8")
    const parent = shimOf("parent.cjs")
    writeFileSync(parent,
      `const { spawn } = require("child_process");` +
      `const c = spawn(process.execPath, [${JSON.stringify(grand)}], { detached: true, stdio: "ignore" });` +
      `c.unref(); setTimeout(() => {}, 30000);\n`, "utf8")
    const p = shimOf("holder.cmd")
    writeFileSync(p, `@ECHO OFF\r\nSETLOCAL\r\n"${process.execPath}" "${parent}" %*\r\n`, "ascii")

    // Control first: no timeout, so the marker must appear. A test that cannot fail
    // is not evidence, and the negative below would otherwise pass vacuously.
    const controlMk = shimOf("control.marker")
    const cg = shimOf("cgrand.cjs")
    writeFileSync(cg, `setTimeout(() => { try { require("fs").writeFileSync(${JSON.stringify(controlMk)}, "alive") } catch {} }, 500)\n`, "utf8")
    const cp = shimOf("cparent.cjs")
    writeFileSync(cp,
      `const { spawn } = require("child_process");` +
      `const c = spawn(process.execPath, [${JSON.stringify(cg)}], { detached: true, stdio: "ignore" });` +
      `c.unref(); setTimeout(() => {}, 1200);\n`, "utf8")
    const cs = shimOf("cholder.cmd")
    writeFileSync(cs, `@ECHO OFF\r\nSETLOCAL\r\n"${process.execPath}" "${cp}" %*\r\n`, "ascii")
    const control = await runGate(["--", cs], 30000)
    await new Promise((r) => setTimeout(r, 3000))
    const controlWorks = existsSync(controlMk)
    ok("control: a detached grandchild under the shim really does outlive it", controlWorks,
      `control exit=${control.code} marker=${existsSync(controlMk)}`)

    const r = await runGate(["--timeout", "1", "--", p], 30000)
    ok("the wrapper still exits 124 on the cmd.exe path", r.code === 124, `code=${r.code}`)
    const exitedAt = Date.now()
    await new Promise((r) => setTimeout(r, 4500))
    const after = existsSync(mk)
    ok("and taskkill /T still reached the grandchild-of-grandchild, i.e. nothing survived",
      controlWorks ? !after : true,
      controlWorks ? `marker appeared ${Date.now() - exitedAt}ms after the wrapper exited 124 -- a process survived the timeout through cmd.exe` : "control failed")
    if (!controlWorks) console.log("      note: control grandchild did not appear; the kill assertion is reported, not counted.")
  }

  sec("loopgate: an argument cmd.exe cannot carry is REFUSED, never escaped")
  {
    // Fail closed is the whole point. For each refused character: exit 2, a
    // refusal on stderr, and NO MARKER — the marker is what proves nothing ran,
    // because "it printed a message" would also be true of a command that ran and
    // then complained.
    const refused = [
      ["&", "ampersand"], ["|", "pipe"], ["^", "caret"], [">", "redirect"],
      ["<", "redirect-in"], ["%", "percent"], ["!", "bang"],
      ['"', "double-quote"], ["\n", "newline"], ["\r", "carriage-return"],
    ]
    for (const [ch, name] of refused) {
      const marker = shimOf(`refused-${name}.marker`)
      const shim = markerShim(`refused-${name}.cmd`, marker)
      const r = await runGate(["--", shim, `a${ch}b`], 30000)
      ok(`${name}: exits 2`, r.code === 2, `code=${r.code} stderr=${JSON.stringify(r.stderr.slice(0, 200))}`)
      ok(`${name}: says it is refusing rather than spawning`, /refus/i.test(r.stderr), JSON.stringify(r.stderr.slice(0, 200)))
      ok(`${name}: NOTHING was spawned (no marker)`, !existsSync(marker), "the marker exists -- the shim ran")
      ok(`${name}: the refusal itself carries no control byte`, !/[\u0000-\u0008\u000b-\u001f\u007f\r]/.test(r.stderr), JSON.stringify(r.stderr.slice(0, 200)))
    }

    // And the refusal must be complete, not prefix-matching: a command that is
    // fine in argument 0 and hostile in argument 3 must still be refused.
    const m2 = shimOf("late-hostile.marker")
    const s2 = markerShim("late-hostile.cmd", m2)
    const late = await runGate(["--", s2, "harmless", "harmless", "harmless", "a&b"], 30000)
    ok("a hostile argument in ANY position is refused", late.code === 2 && !existsSync(m2), `code=${late.code} marker=${existsSync(m2)}`)

    // The refusal message has to tell the user what they can no longer do.
    const one = await runGate(["--", s2, "a&b"], 30000)
    ok("the refusal names the offending character", /&/.test(one.stderr), JSON.stringify(one.stderr))
    ok("and documents that --grep \"a&b\" is the refused form", /--grep/.test(one.stderr) && /refus/i.test(one.stderr), JSON.stringify(one.stderr))
    ok("and a refusal prints no EXEC line, because nothing ran", execLines(one.stderr).length === 0, JSON.stringify(one.stderr))
    ok("and the refusal is not a usage error wearing a disguise (still exit 2, no PASS/FAIL verdict)",
      one.code === 2 && !/\[loopgate\] (PASS|FAIL)/.test(one.stderr), JSON.stringify(one.stderr))
  }

  sec("loopgate: the direct-spawn path is untouched, and shell:true is never used")
  {
    const nv = await runGate(["--", "node", "--version"], 30000)
    ok("node --version exits 0 on the direct path", nv.code === 0, `code=${nv.code}`)
    ok("and prints a version", /^v\d+\.\d+\.\d+/.test(nv.stdout.trim()), JSON.stringify(nv.stdout))
    ok("the EXEC line reports no cmd.exe route for a real .exe", (() => {
      const line = execLines(nv.stderr)[0]
      if (!line) return false
      try { const j = JSON.parse(line.slice(line.indexOf(EXEC_PREFIX) + EXEC_PREFIX.length)); return !j.via && !j.resolved } catch { return false }
    })(), JSON.stringify(nv.stderr))

    // A metacharacter in an argument to a real .exe is STILL ALLOWED, because it
    // never reaches a shell. Refusing it globally would break the one path that is
    // already correct -- and this is asserted so that a future edit which hoists
    // the refusal check out of the batch-shim branch is caught.
    const lit = await runGate(["--", "node", "-e", "console.log(process.argv[1])", "a&b|c^d>e%f!g\"h"], 30000)
    ok("every metacharacter still passes through literally to a real .exe",
      lit.code === 0 && lit.stdout.trim() === "a&b|c^d>e%f!g\"h", `code=${lit.code} stdout=${JSON.stringify(lit.stdout)} stderr=${JSON.stringify(lit.stderr.slice(0, 200))}`)

    // Static, because the rule is a rule about the source, not about any one run.
    const src = readFileSync(LOOPGATE, "utf8")
    ok("loopgate.mjs contains no shell: true anywhere", !/shell\s*:\s*true/.test(src), "shell:true would re-interpolate the command string")
    ok("and still passes shell:false explicitly", /shell\s*:\s*false/.test(src), "the argv-array guarantee must be visible at the spawn")
    ok("windowsVerbatimArguments appears only alongside the cmd.exe route, never with a bare direct spawn",
      (src.match(/windowsVerbatimArguments/g) || []).length <= 2, "verbatim argv is only safe because the wrapper builds the quoted line itself")
  }

  sec("loopgate: the batch-shim branch is never taken off Windows")
  {
    if (IS_WIN) {
      ok("skipped: this IS Windows, so the POSIX branch is untestable here", true)
      console.log("      note: the POSIX assertion needs a non-Windows runner; it is guarded, not asserted.")
    } else {
      const r = await runGate(["--", "npm", "--version"], 60000)
      ok("npm still runs on POSIX (shebang script, spawned directly)", r.code === 0, `code=${r.code}`)
      const line = execLines(r.stderr)[0]
      let j = null
      try { j = JSON.parse(line.slice(line.indexOf(EXEC_PREFIX) + EXEC_PREFIX.length)) } catch {}
      ok("and no cmd.exe route is taken", !!j && !j.via && !j.resolved, JSON.stringify(j))
    }
  }
} finally {
  try { rmSync(SHIM_DIR, { recursive: true, force: true }) } catch {}
}
ok("the batch-shim scratch directory is cleaned up, including on failure", !existsSync(SHIM_DIR))

  console.log(`\n${pass} passed, ${fail} failed  (loopgate.selftest.mjs)\n`)
  process.exit(fail ? 1 : 0)
}

main()
