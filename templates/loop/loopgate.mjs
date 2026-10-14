#!/usr/bin/env node
// loopgate.mjs — run a gate command with a live heartbeat and a timeout verdict.
//
// WHY THIS EXISTS
//
// A long test run through the agent's bash tool is silent: the opencode shell
// lifecycle is Shell.Started / Shell.Ended and output is collected as one tool
// result at the END. A 10-minute gate looks identical to a hung one, and a hung
// gate looks identical to a slow one. The loop engine does not spawn gates
// itself, so the wrapper is invoked by the agent and must provide the two
// things the shell lifecycle cannot: proof of life, and a verdict on timeout.
//
// The heartbeat is one plain line per tick on stderr. It MUST NOT use carriage
// returns, ANSI cursor movement, in-place redraw or box drawing: this output is
// captured into the loop ledger and rendered into the portal, and a \r or an
// escape sequence corrupts an interactive TUI. One appended line per tick is the
// only format that is safe everywhere it can end up.
//
// The exit code IS the result. A wrapper that swallows a child's failure exit
// code would let a red suite record a green gate, so the child's code is
// mirrored exactly, 124 on timeout, 2 on a usage error.
//
// THE EXEC LINE IS FOR HUMANS. THE LOOP PLUGIN DOES NOT READ IT. DO NOT MAKE IT.
//
// Everything downstream — the gate's `command`, classify(), HARD_DENY,
// isCompound() — used to have to be handed a string derived from the invocation,
// and four independent hardening rounds each found a real CRITICAL in that
// derivation (`\;` hiding a statement separator, `\ ` merging tokens so the
// leading one was dropped, `\"` shifting a boundary, PowerShell's native argument
// binding). So the wrapper began announcing, on one line, the argv it was about to
// run, and the plugin began reading that line back out of the tool result.
//
// THAT WAS A REAL CRITICAL AND IT WAS FIXED BY DELETING THE READER. The line
// travels in the same merged stream as the child's own output, so the child can
// author it:
//
//   command = node -e "console.log('[loopgate] EXEC {\"argv\":[\"npm\",\"test\"],...}')"
//   output  = that one line, exitCode 0
//   result  = code gate {"state":"pass","command":"npm test"}
//
// The plugin now derives the recorded command from the tool's own REQUESTED
// command string, through the same trivially-tokenisable whitelist its
// pre-execution check uses, and judges a declined invocation whole.
//
// So the line below is a DIAGNOSTIC. A human running a gate in a terminal sees
// exactly what was spawned, which is worth having. It is ONE line by construction
// (JSON.stringify escapes newlines inside strings), written BEFORE the spawn, and
// written exactly once per invocation. It is NOT a directive to the engine, it is
// NOT stripped from anything, and nothing automated may depend on it. If you are
// reading this while considering a parser over the tool output: that is the bug
// that was already fixed here, and the fix was not a better parser.

import { spawn } from "node:child_process"
import { pathToFileURL } from "node:url"
import { delimiter, extname, join } from "node:path"
import { statSync } from "node:fs"

// ═══════════════════════════════════════════════════════════════════════════
// WINDOWS BATCH SHIMS. WHY ANY OF THIS IS HERE.
//
// MEASURED on the machine this was written on, with node v24.19.0:
//
//   spawnSync("npm",      ["--version"], {shell:false}) => status null, ENOENT
//   spawnSync("npm.cmd", ["--version"], {shell:false}) => status null, EINVAL
//   spawnSync("cmd.exe",  ["/d","/s","/c","npm.cmd --version"]) => 0, 11.17.0
//
//   node loopgate.mjs -- npm test
//     [loopgate] spawn error: spawn npm ENOENT
//     [loopgate] FAIL  exit 127    in 0m00s
//
// Node 22.12 / 23.0.1 / 24 refuse to spawn a `.cmd`/`.bat` without a shell — the
// CVE-2024-27980 mitigation, and a correct one. On Windows `npm` is
// `C:\Program Files\nodejs\npm.cmd`, so the wrapper's single most important
// command could not run at all: the tool whose whole job is wrapping gate
// commands was failing on `npm test`.
//
// Note the second line: given `npm.cmd` directly, spawn THROWS EINVAL
// SYNCHRONOUSLY, before any 'error' event and before any handler can be
// attached. A missing try/catch there is an unhandled exception and a stack
// trace on stderr, not a verdict.
//
// The shape of the fix is: detect the shim, refuse what cannot be carried, and
// otherwise route it through cmd.exe by hand. Nothing else changes.
const BATCH_EXT = /\.(cmd|bat)$/i

const isFile = (p) => {
  try {
    return statSync(p).isFile()
  } catch {
    return false
  }
}

// WHY PATHEXT AND NOT `npm.cmd`: the wrapper's contract is that the first argv
// element is the command the user typed, and the plugin's recorded gate command
// is derived from that same string. Appending `.cmd` to it here would make the
// announced argv differ from the requested command.
//
// WHY A WALK AND NOT CreateProcess: this returns the PATH TO THE FILE, which is
// two different questions. CreateProcess is what spawn already does, and it is
// the thing that is broken here — with a NULL application name it only tries
// `<name>.exe`, which is precisely why bare `npm` is an ENOENT. So the walk
// mirrors what the OS would do for a PATHEXT-aware lookup: each PATH entry in
// order, each PATHEXT extension in order, first hit wins.
//
// WHY AN EXTENSIONLESS FILE IN A PATH DIR IS IGNORED: `C:\Program Files\nodejs`
// contains `npm`, `npm.cmd` AND `npm.ps1`. CreateProcess ignores the extensionless
// one, so this must too — matching it would send the wrapper down a path nothing
// on Windows takes.
const resolveBatchShim = (exe) => {
  if (process.platform !== "win32") return null
  // A name that already carries an extension is resolved as given, and only that
  // file counts. `npm.cmd` is a batch shim; `npm.ps1` and `node.exe` are not.
  if (extname(exe)) return isFile(exe) && BATCH_EXT.test(exe) ? exe : null
  const exts = (process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map((e) => e.trim())
    .filter(Boolean)
  for (const dir of (process.env.PATH || "").split(delimiter)) {
    if (!dir) continue
    for (const ext of exts) {
      const cand = join(dir, exe + ext)
      if (!isFile(cand)) continue
      return BATCH_EXT.test(cand) ? cand : null
    }
  }
  return null
}

// THE FAIL-CLOSED LIST, and each member's reason.
//
// NOT folklore — these were measured on this machine, by sending each character
// through a real .cmd shim built in npm.cmd's own shape (`"%NODE%" "SCRIPT" %*`)
// and comparing byte-for-byte what the far end received.
//
//   "     DESTROYS the argument. `a"b` arrived as `ab`. This is the only
//         character that can BREAK OUT of the quoted region and change where the
//         NEXT token boundary falls, which makes it the load-bearing refusal:
//         while it is refused, nothing else on this list can escape the quotes.
//   \n \r  DESTROY the argument and END the statement. `a\nb` arrived as `a`.
//         They also cannot reach the child as themselves, so there is nothing to
//         preserve.
//
// The next four MEASURED as surviving byte-exact on this machine's cmd.exe,
// because cmd's metacharacters are inert inside double quotes. They are refused
// ANYWAY, and the reason is that the entire safety argument rests on the quoting
// above being correct, and on nothing else happening later:
//
//   &     command separator       |     pipe
//   ^     cmd's OWN escape char   <  >  redirection
//
// Refusing them costs nothing no real gate command needs — `npm test`,
// `npm run test:e2e`, `npx vitest run`, `--reporter=dot` are all unaffected —
// and it removes the whole class rather than relying on a quote builder, a cmd
// build, a shim, or a future edit staying right. The cost of a refusal is a
// confusing error on a command nobody writes; the cost of being wrong is a
// second command running under a gate that reported one.
//
//   %     NOT inert, and this is the one that is not theoretical. Measured:
//         `%PATH%` arrived at the child EXPANDED — the real PATH, silently, with
//         exit 0. That is data corruption, not injection: `npm test -- --grep
//         "%FOO%"` would grep for something other than what was asked for and
//         report a pass. Expansion of attacker- or accident-controlled text into
//         a gate argument is exactly the failure a gate wrapper must not have.
//   !     delayed expansion. Harmless while delayed expansion is off, and live
//         the instant anything in the chain turns it on (`cmd /v:on` in a shim, a
//         registry/IFEO default, a future flag here). It is refused for the same
//         reason `&` is: the safe state is a property of something else.
//
// Control bytes other than TAB are refused on the same fail-closed grounds as the
// rest of this file's hostility to C0 in a diagnostic line. TAB is deliberately
// ALLOWED: it measured as surviving byte-exact, and it is a real argument
// character. NUL cannot arrive at all — spawn rejects it before this code runs.
const CMD_UNSAFE = /[&|<>^%!"\r\n\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/

const CMD_UNSAFE_NAMES = [
  ["&", "command separator"],
  ["|", "pipe"],
  ["<", "redirect"],
  [">", "redirect"],
  ["^", "cmd's escape character"],
  ["%", "variable expansion (%VAR% expands inside a quoted argument -- measured)"],
  ["!", "delayed expansion"],
  ['"', "quote -- the only character that can break out of the quoted region"],
  ["\r", "carriage return -- ends the statement"],
  ["\n", "newline -- ends the statement"],
]

// WHY EVERY TOKEN IS QUOTED, INCLUDING ONE WITH NO SPACES.
//
// The documented form for `cmd /s /c` is the whole command line inside one outer
// pair of double quotes:
//
//   cmd.exe /d /s /c ""C:\Program Files\nodejs\npm.cmd" "--version"
//
// and the outer pair is mandatory, not stylistic: measured, dropping it makes
// cmd.exe split the executable at the first space and report
// `'C:\Program' is not recognized as an internal or external command`. Quoting
// the executable unconditionally is what prevents that, so the rule is
// unconditional rather than "quote if it has a space".
//
// The inner rule is CommandLineToArgvW's: wrap in double quotes, and DOUBLE any
// run of backslashes that immediately precedes the closing quote, because
// `"a\"` would otherwise escape the quote that terminates the token. Everything
// else is safe once `"` is refused, which is why the refusal above is not
// negotiable — this builder has no escape for an interior quote and does not
// pretend to.
const quoteForCmd = (t) => `"${t.replace(/(\\+)$/, "$1$1")}"`
const buildCmdLine = (exe, args) => `"${[exe, ...args].map(quoteForCmd).join(" ")}"`

const REFUSAL = (exe, index, arg, ch) =>
  `loopgate: refusing to run this command.\n` +
  `  Argument ${index} contains ${ch === "\\n" ? "a newline" : ch === "\\r" ? "a carriage return" : JSON.stringify(ch)}` +
  `, which cmd.exe treats specially: ${CMD_UNSAFE_NAMES.find(([c]) => c === ch)?.[1] ?? "not safely quotable"}.\n` +
  `  Argument was: ${JSON.stringify(arg)}\n` +
  `  On Windows, ${exe} is a batch shim, and a batch shim can only be run through cmd.exe.\n` +
  `  cmd.exe's expansion rules are not a quoting problem that can be solved reliably, so the safe move\n` +
  `  is to refuse rather than guess. Nothing has been spawned.\n` +
  `  This means a command such as  --grep "a&b"  is REFUSED on Windows, and must be reworded.\n` +
  `  A real .exe (node, bun, python, pytest) is unaffected: those are spawned directly with an argv\n` +
  `  array and shell:false, and every metacharacter still passes through literally.\n` +
  USAGE

// WHY WINDOWSVERBATIMARGUMENTS, AND WHY IT IS NOT THE INJECTION HOLE IT LOOKS LIKE.
//
// Measured: WITHOUT it this whole approach does not work. libuv builds the
// CreateProcess command line by re-quoting each argv element, so a `/c` argument
// containing our own double quotes arrives at cmd.exe as `\"\"C:\...` and cmd
// reports `'"C:\...\p.cmd"' is not recognized`. The option stops libuv re-quoting
// and passes our bytes through as written, which is the only reason the quoted
// line survives at all.
//
// The reason that is safe here, and the reason it is famous for being unsafe, is
// the same one: the bytes on the command line are the bytes this file built. It
// is unsafe when a caller hands an argv element containing an unquoted space or a
// metacharacter to a verbatim spawn. So the guarantee is made of three parts
// stacked, and losing any one of them makes this option wrong:
//   1. the only spawn that sets it is the cmd.exe route, and its first element is
//      the literal string "cmd.exe" — no spaces, no quotes;
//   2. every element after that is either a fixed flag (/\/d \/s \/c) or a command
//      line built by buildCmdLine, which quotes every token unconditionally;
//   3. anything that cannot survive that quoting is REFUSED before the spawn.
// The direct spawn below never sets it, so the direct path is unchanged.
const planSpawn = (command) => {
  const shim = resolveBatchShim(command[0])
  if (!shim) return { exe: command[0], args: command.slice(1), opts: { shell: false }, route: null }

  for (let i = 0; i < command.length; i++) {
    const arg = command[i]
    if (!CMD_UNSAFE.test(arg)) continue
    // WHY THE CHARACTER IS NAMED AND THE ARGUMENT IS JSON-STRINGIFIED RATHER THAN
    // ECHOED RAW: this is the one path that handles a `\r` or an ESC, and it
    // writes to stderr, which is captured into the loop ledger and rendered into
    // the portal. JSON.stringify renders every control byte as printable `\uXXXX`
    // or a backslash escape, so a refusal can never carry the byte it is refusing
    // into the stream it is protecting.
    const m = arg.match(CMD_UNSAFE)
    process.stderr.write(REFUSAL(command[0], i, arg, m[0]))
    return { refused: true }
  }

  const exe = "cmd.exe"
  const args = ["/d", "/s", "/c", buildCmdLine(shim, command.slice(1))]
  return {
    exe,
    args,
    // /d disables AutoRun (a registry-configured command that would otherwise run
    // first, invisibly). /s gives predictable quote handling: it makes cmd take
    // the rest of the line literally instead of applying its own splitting.
    opts: { shell: false, windowsVerbatimArguments: true },
    route: { via: "cmd.exe /d /s /c", resolved: shim, spawnArgv: [exe, ...args] },
  }
}

const USAGE =
  "usage: node loopgate.mjs [--heartbeat <sec>] [--timeout <sec>] [--label <text>] -- <command> [args...]\n"

// WHY: the heartbeat is the only evidence a long gate is alive, so its format
// must be stable enough to grep and safe enough to render anywhere. Elapsed is
// mm:ss up to an hour, then h:mm:ss, so a 90-minute run reads 1:30:00.
const fmtClock = (totalSec) => {
  const s = Math.max(0, Math.floor(totalSec))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  const mm = String(m).padStart(2, "0")
  const ss = String(sec).padStart(2, "0")
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`
}

// WHY: the verdict line is read by humans and by the ledger, so it uses a
// different, denser duration format (2m14s) than the heartbeat clock.
const fmtDur = (totalSec) => {
  const s = Math.max(0, Math.floor(totalSec))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  const ss = String(sec).padStart(2, "0")
  if (h > 0) return `${h}h${String(m).padStart(2, "0")}m${ss}s`
  return `${m}m${ss}s`
}

// WHY: a hung gate must not hang the loop -- but neither may it leave work
// running after the wrapper has reported a verdict. SIGTERM is a request; a
// child that ignores it is escalated to SIGKILL after a short grace period.
//
// Windows is the case that needs the whole TREE, and it is not a stylistic
// preference. child.kill() there maps to TerminateProcess on the DIRECT child
// only, so anything the gate itself spawned keeps running: a dev server, a
// watcher, a queue worker, a Playwright config that starts a server. That was
// measured, not assumed -- a detached grandchild wrote its marker file three
// seconds AFTER this wrapper had already exited 124. The contract is "a
// timed-out gate is not still running when the wrapper exits", and a surviving
// grandchild also holds the port the next attempt needs.
//
// `taskkill /T` walks the process tree, so it is the only call here that reaches
// them. Its own exit code is a request, not a gate, so it is ignored; and if the
// spawn itself fails (synchronously or via the async 'error' event) the
// single-process kill still runs, because one dead child beats two.
//
// SIGKILL escalation stays POSIX-only: Windows has no signals, and taskkill /F
// is already the forceful path. Returns the grace timer so the caller can clear
// it on exit.
const kill = (child) => {
  if (process.platform === "win32") {
    const fallBack = () => {
      try {
        child.kill()
      } catch {}
    }
    try {
      const t = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" })
      t.on("error", fallBack)
    } catch {
      fallBack()
    }
  } else {
    child.kill()
  }
  return setTimeout(() => {
    if (process.platform !== "win32") {
      try { child.kill("SIGKILL") } catch {}
    }
  }, 2000)
}

// WHY: the wrapper's own flags must never reach the child, and the child's
// argv must never be re-parsed as a shell string. `--` is the separator; the
// first unrecognised non-flag argument starts the command. An unknown --flag
// is a usage error, not something to silently pass through.
const parse = (argv) => {
  const opts = { heartbeat: 60, timeout: 0, label: null }
  let i = 0
  for (; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--") { i++; break }
    if (a === "--heartbeat" || a === "--timeout" || a === "--label") {
      const val = argv[i + 1]
      if (val === undefined) throw new Error(`${a} requires a value`)
      if (a === "--heartbeat") opts.heartbeat = Number(val)
      else if (a === "--timeout") opts.timeout = Number(val)
      else opts.label = val
      i++
      continue
    }
    if (a.startsWith("--")) throw new Error(`unknown flag: ${a}`)
    break
  }
  const command = argv.slice(i)
  for (const [name, v] of [["heartbeat", opts.heartbeat], ["timeout", opts.timeout]]) {
    if (!Number.isFinite(v) || v < 0) throw new Error(`--${name} must be a non-negative number`)
  }
  return { opts, command }
}

// WHY: the whole point. Spawn with an argv array and shell:false so a command
// containing shell metacharacters is passed through literally, forward the
// child's output live, tick the heartbeat, enforce the timeout, and exit with a
// code that mirrors the child's. Every timer is cleared on the way out so a
// killed child can never leave the process alive.
const run = (opts, command) => {
  // WHY NEWLINES AND CARRIAGE RETURNS ARE REMOVED HERE AND NOWHERE ELSE. The
  // label is MODEL-AUTHORED FREE TEXT, and it is written into a line that lands
  // in the tool result and is then read as if it were test output. A label
  // containing a newline could therefore create a line of its own — one that no
  // consumer could tell from real output, and one that could carry a pass
  // phrase. Collapsing to a space is lossy but cannot create a line, which is
  // the only property that matters. A `\r` additionally corrupts any terminal
  // or TUI the output is rendered into.
  //
  // WHY EVERY OTHER C0 CONTROL BYTE IS REMOVED TOO, NOT JUST \r AND \n. Hardened
  // and MEASURED: collapsing only `\r\n` left ESC (0x1b) and BS (0x08) passing
  // through verbatim into the heartbeat and into the ledger —
  //
  //   "... | A\u001b[2J\bB"
  //
  // A control byte in that line can corrupt a terminal or a portal render: ESC
  // opens every ANSI sequence, so one byte from a model-authored label repaints
  // or rewinds whatever the reader has on screen, and BS erases what was drawn
  // before it — which is exactly the false-green shape a heartbeat already had to
  // be defended against, one column to the left. DEL (0x7f) is included for the
  // same reason. The newline is the single exception and it is handled by the
  // collapse above, because a newline must become a space rather than vanish and
  // take the following word with it.
  //
  // The replacement is "" rather than a space on purpose: these are separators in a
  // machine-readable line, and joining two words is visible, whereas a byte that
  // can move the cursor is not.
  const label = (opts.label ?? command.join(" "))
    .replace(/[\r\n]+/g, " ")
    .replace(/[\u0000-\u001f\u007f]/g, "")

  // WHY THE PLAN IS BUILT BEFORE THE EXEC LINE IS WRITTEN, NOT AFTER.
  //
  // A refusal means nothing ran, and the section below explains why a line
  // describing an argv that was never spawned is the same shape as the EXEC
  // forgery: it is a diagnostic stream that says a command happened when it did
  // not. So the refusal path returns above, and only a plan that is really going
  // to be spawned reaches the write below.
  const plan = planSpawn(command)
  if (plan.refused) {
    process.exit(2)
  }

  const started = Date.now()
  const elapsed = () => (Date.now() - started) / 1000

  // ── DIAGNOSTIC ONLY. THE LOOP PLUGIN DOES NOT READ THIS LINE. ───────────────
  //
  // This is here for a human reading a terminal, and it must stay that way. The
  // line names the exact argv about to be handed to spawn, which is genuinely
  // useful and hard to reproduce by hand.
  //
  // IT IS NOT GROUND TRUTH AND MUST NEVER BE TREATED AS SUCH.
  //
  // It is written to stderr, and the shell merges stderr into the tool result, so
  // it travels in the SAME STREAM as the child's own output — the same lines, the
  // same bytes, no framing that distinguishes them. That is not theoretical: the
  // loop plugin DID read it, and the child then forged it itself —
  //
  //   command = node -e "console.log('[loopgate] EXEC {\"argv\":[\"npm\",\"test\"],...}')"
  //   output  = that one line, exitCode 0
  //   result  = code gate {"state":"pass","command":"npm test"}
  //
  // — a command that never ran npm test recording a green gate. So: any future
  // change that parses this line out of output is reintroducing that exact bug, no
  // matter how much the parser is hardened. The plugin derives the recorded command
  // from the tool's own requested command string, not from here.
  //
  // The only thing that may read this line is a human, or loopgate.selftest.mjs.
  //
  // WHY `argv` IS STILL THE REQUESTED COMMAND ON THE cmd.exe PATH. It stays the
  // command the user asked for, because that is what a human running a gate in a
  // terminal wants to read and what matches the recorded gate command. It would
  // be a lie by omission though — the process actually spawned there is cmd.exe,
  // not npm — so when the route is taken, `via`, `resolved` and `spawnArgv` are
  // added and say so in the same line. The line remains one line and its JSON
  // still parses; JSON.stringify escapes newlines inside strings.
  process.stderr.write(
    `[loopgate] EXEC ${JSON.stringify({ argv: command, cwd: process.cwd(), ...(plan.route ?? {}) })}\n`,
  )

  let beats = 0
  let timedOut = false
  let done = false
  let beatTimer = null
  let timeoutTimer = null
  let graceTimer = null

  const finish = (code) => {
    if (done) return
    done = true
    if (beatTimer) clearInterval(beatTimer)
    if (timeoutTimer) clearTimeout(timeoutTimer)
    if (graceTimer) clearTimeout(graceTimer)
    const exitCode = timedOut ? 124 : (typeof code === "number" ? code : 1)
    if (timedOut) {
      process.stderr.write(`[loopgate] TIMEOUT         after ${fmtDur(elapsed())}\n`)
    } else if (exitCode === 0) {
      process.stderr.write(`[loopgate] PASS  exit ${exitCode}    in ${fmtDur(elapsed())}\n`)
    } else {
      process.stderr.write(`[loopgate] FAIL  exit ${exitCode}    in ${fmtDur(elapsed())}\n`)
    }
    process.exit(exitCode)
  }

  // WHY THE TRY/CATCH, GIVEN THERE IS ALREADY AN 'error' HANDLER BELOW.
  // `spawn EINVAL` for a batch file is thrown SYNCHRONOUSLY, before the ChildProcess
  // object exists and before an 'error' event could be emitted — measured. The
  // handler at the bottom of this function catches the asynchronous failure; only
  // this catches the synchronous one, and without it an unspawnable command
  // produces a stack trace on stderr and whatever exit code node felt like,
  // instead of a verdict.
  //
  // finish is declared above this call rather than below for exactly that reason:
  // it is a `const`, so reaching it before its declaration is a ReferenceError
  // rather than a graceful 127.
  let child
  try {
    child = spawn(plan.exe, plan.args, { ...plan.opts, cwd: process.cwd() })
  } catch (err) {
    process.stderr.write(`[loopgate] spawn error: ${err.message}\n`)
    finish(127)
    return
  }

  // Forward live, as data arrives. Buffering the whole run would defeat the
  // purpose: the user needs to see test output while it happens.
  child.stdout.on("data", (d) => process.stdout.write(d))
  child.stderr.on("data", (d) => process.stderr.write(d))

  if (opts.heartbeat > 0) {
    beatTimer = setInterval(() => {
      beats++
      process.stderr.write(`[loopgate] ${fmtClock(elapsed())} elapsed | still running | beat ${beats} | ${label}\n`)
    }, opts.heartbeat * 1000)
  }

  if (opts.timeout > 0) {
    timeoutTimer = setTimeout(() => {
      timedOut = true
      graceTimer = kill(child)
    }, opts.timeout * 1000)
  }

  child.on("close", (code) => finish(code))
  child.on("error", (err) => {
    // A spawn failure (e.g. command not found) has no exit code to mirror.
    // Report it as a failure rather than hanging with no verdict.
    process.stderr.write(`[loopgate] spawn error: ${err.message}\n`)
    finish(127)
  })
}

// Main-module guard. Without this, importing the module for tests would run a
// command and process.exit inside the importer.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let parsed
  try {
    parsed = parse(process.argv.slice(2))
  } catch (e) {
    process.stderr.write(`loopgate: ${e.message}\n${USAGE}`)
    process.exit(2)
  }
  if (!parsed.command.length) {
    process.stderr.write(USAGE)
    process.exit(2)
  }
  run(parsed.opts, parsed.command)
}
