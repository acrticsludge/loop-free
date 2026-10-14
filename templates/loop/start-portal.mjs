// Single entry point for starting the loop portal.
//
// Lifecycle is deliberate. By default the portal runs WITHOUT the persist
// flag, so it stops itself ~15s after the last opencode loop session ends. That
// is the behaviour you asked for: nothing is listening when you are not working.
//
// `keepalive` opts out of that, for when you want the dashboard up with no loop
// running. It says so, because that mode never exits on its own.

import { spawn } from "node:child_process"
import { randomBytes } from "node:crypto"
import { readFileSync, existsSync, writeFileSync, mkdirSync, rmSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"

const HERE = join(homedir(), ".config", "opencode", "loop")
const DATA = join(homedir(), ".local", "share", "opencode", "loopguard")
const PORT = Number(process.env.LOOP_PORTAL_PORT ?? 7317)
const argv = process.argv.slice(2)
const cmd = argv[0] ?? "start"

const health = async () => {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/health`, { signal: AbortSignal.timeout(800) })
    const j = await r.json()
    return j?.service === "loop-portal" ? j : null
  } catch {
    return null
  }
}

const token = () => {
  const p = join(DATA, "portal-token")
  try {
    if (!existsSync(p)) {
      mkdirSync(DATA, { recursive: true })
      writeFileSync(p, randomBytes(24).toString("base64url"), "utf8")
    }
    return readFileSync(p, "utf8").trim()
  } catch {
    return ""
  }
}

if (cmd === "stop") {
  const h = await health()
  if (!h) {
    console.log("not running")
    process.exit(0)
  }
  const pidFile = join(DATA, "portal.pid")
  try {
    process.kill(Number(readFileSync(pidFile, "utf8").trim()), "SIGTERM")
    rmSync(pidFile, { force: true })
    console.log("stopped")
  } catch {
    console.log("running but pid unknown; kill it manually")
  }
  process.exit(0)
}

const live = await health()
if (live) {
  console.log(`already running on http://127.0.0.1:${PORT}/?t=${token()}`)
  console.log(`  live sessions: ${live.sessions}  narrate: ${live.narrate}`)
  process.exit(0)
}

const persist = cmd === "keepalive"
const child = spawn(process.execPath, [join(HERE, "portal.mjs")], {
  detached: true,
  stdio: "ignore",
  env: persist ? { ...process.env, LOOP_PORTAL_PERSIST: "1" } : process.env,
})
child.unref()

try {
  mkdirSync(DATA, { recursive: true })
  writeFileSync(join(DATA, "portal.pid"), String(child.pid), "utf8")
} catch {}

await new Promise((r) => setTimeout(r, 1200))
const up = await health()
const t = token()
if (!up) {
  console.error("failed to start; see portal.log")
  process.exit(1)
}

const pub = (() => {
  try {
    const p = join(DATA, "public-url.txt")
    return existsSync(p) ? readFileSync(p, "utf8").trim() : ""
  } catch {
    return ""
  }
})()

console.log(`portal up  pid ${child.pid}`)
console.log(`  local:  http://127.0.0.1:${PORT}/?t=${t}`)
if (pub) console.log(`  public: ${pub}/?t=${t}`)
console.log(
  persist
    ? "  KEEPALIVE: this will run until you stop it. Use '/portal stop'."
    : "  lifecycle: stops itself ~15s after the last loop session ends.",
)
