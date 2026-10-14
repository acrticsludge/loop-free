import http from "node:http"
import { spawn } from "node:child_process"
import { createHash, randomBytes, timingSafeEqual } from "node:crypto"
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const DATA_DIR = join(homedir(), ".local", "share", "opencode", "loopguard")
const RUNS_DIR = join(DATA_DIR, "runs")
const EVENTS_DIR = join(DATA_DIR, "events")
const TOKEN_FILE = join(DATA_DIR, "portal-token")
const PUBLIC_URL_FILE = join(DATA_DIR, "public-url.txt")
const UI_FILE = join(homedir(), ".config", "opencode", "loop", "ui.html")
const PORT = Number(process.env.LOOP_PORTAL_PORT ?? 7317)
const HOST = "127.0.0.1"
const ALIVE_MS = 90_000
const REAP_GRACE_MS = 15_000
const NARRATE_ALLOWED = process.env.LOOP_PORTAL_NARRATE === "1"
const PERSIST = process.env.LOOP_PORTAL_PERSIST === "1"
const LOG_FILE = join(DATA_DIR, "portal.log")

const log = (...a) => {
  const line = `[${new Date().toISOString()}] ${a.join(" ")}\n`
  try {
    mkdirSync(DATA_DIR, { recursive: true })
    appendFileSync(LOG_FILE, line, "utf8")
  } catch {}
}
process.on("uncaughtException", (e) => log("UNCAUGHT", e?.stack ?? String(e)))
process.on("unhandledRejection", (e) => log("UNHANDLED", e?.stack ?? String(e)))
process.on("SIGTERM", () => {
  log("SIGTERM, exiting")
  process.exit(0)
})

const NARRATOR_MODEL = process.env.LOOP_PORTAL_MODEL ?? "opencode-go/longcat-2.5-preview-free"

const token = () => {
  try {
    if (!existsSync(TOKEN_FILE)) {
      mkdirSync(DATA_DIR, { recursive: true })
      writeFileSync(TOKEN_FILE, randomBytes(24).toString("base64url"), "utf8")
    }
    return readFileSync(TOKEN_FILE, "utf8").trim()
  } catch {
    return ""
  }
}
const TOKEN = token()
const safeEqual = (a, b) => {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

const offsets = new Map()
const runs = new Map()
const clients = new Set()
const narrating = new Set()

const key = (repoHash, sid) => `${repoHash}/${sid}`

const listJson = (dir) => {
  try {
    if (!existsSync(dir)) return []
    return readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
  } catch {
    return []
  }
}

function readLedger(repoHash, sid) {
  try {
    const p = join(RUNS_DIR, repoHash, `${sid}.json`)
    if (!existsSync(p)) return null
    return JSON.parse(readFileSync(p, "utf8"))
  } catch {
    return null
  }
}

function getRun(repoHash, sid) {
  const k = key(repoHash, sid)
  let r = runs.get(k)
  const led = readLedger(repoHash, sid)
  if (!r) {
    r = { id: k, repoHash, sid, events: [], lastEventAt: 0, narr: null, narrState: "idle" }
    runs.set(k, r)
  }
  if (led) r.ledger = led
  if (!r.ledger) return null
  return r
}

function tail(repoHash, sid) {
  const k = key(repoHash, sid)
  const p = join(EVENTS_DIR, repoHash, `${sid}.jsonl`)
  const r = getRun(repoHash, sid)
  if (!r) return
  if (!existsSync(p)) return
  let content
  try {
    content = readFileSync(p, "utf8")
  } catch {
    return
  }
  const lines = content.split("\n")
  if (!content.endsWith("\n")) lines.pop()
  const consumed = offsets.get(k) ?? 0
  if (lines.length < consumed) {
    r.events = []
    offsets.set(k, 0)
  }
  const start = offsets.get(k) ?? 0
  for (let i = start; i < lines.length; i++) {
    const line = lines[i]
    if (!line.trim()) continue
    try {
      const ev = JSON.parse(line)
      r.events.push(ev)
      if (ev.k !== "hb" && ev.k !== "msg") r.lastEventAt = ev.t
    } catch {}
  }
  offsets.set(k, lines.length)
  if (r.events.length > 500) r.events = r.events.slice(-500)
}

function scan() {
  for (const repoHash of listJson(RUNS_DIR)) {
    let sids = []
    try {
      sids = readdirSync(join(RUNS_DIR, repoHash))
        .filter((f) => f.endsWith(".json"))
        .map((f) => f.replace(/\.json$/, ""))
    } catch {
      continue
    }
    for (const sid of sids) {
      tail(repoHash, sid)
      getRun(repoHash, sid)
    }
  }
}

const aliveCount = () => {
  let n = 0
  const now = Date.now()
  for (const r of runs.values()) {
    const led = r.ledger
    if (!led) continue
    if (now - Math.max(r.lastEventAt, led.startedAt ?? 0) < ALIVE_MS) n++
  }
  return n
}

function synthesise(r) {
  const l = r.ledger
  const now = Date.now()
  const last = r.events[r.events.length - 1]
  const recent = (e) => now - e.t < 15 * 60_000

  const usage = [...r.events].reverse().find((e) => e.k === "limit" && e.cls === "usage")
  if (usage && recent(usage))
    return {
      state: "degraded",
      tone: "warn",
      headline: "Degraded — paid tier exhausted",
      detail: `Remaining nodes route to the free tier (longcat-2.5-preview-free) and the run is labelled DEGRADED. Gates must still PASS.${usage.resetAt ? ` Quota resets ${new Date(usage.resetAt).toLocaleTimeString()}.` : " Reset time not reported by the provider."}`,
    }

  const transient = [...r.events].reverse().find((e) => e.k === "limit" && e.cls === "transient")
  if (transient && recent(transient))
    return {
      state: "degraded",
      tone: "warn",
      headline: "Rate limited â€” transient",
      detail: transient.resetAt
        ? `Descending the ladder, retrying at or after ${new Date(transient.resetAt).toLocaleTimeString()}.`
        : "Descending the ladder and retrying the same rung.",
    }

  // A node that never returns looks identical to one that is grinding, and a
  // subagent writes to a child session, so silence is the only signal there is.
  // Warn well before it becomes a stall, so a human can intervene rather than
  // discover twenty minutes later that nothing happened.
  const held = Object.entries(l.stages ?? {}).filter(([, s]) => s.state === "enter")
  if (held.length) {
    const [key, rec] = held.sort((a, b) => (b[1].at ?? 0) - (a[1].at ?? 0))[0]
    const heldFor = now - (rec.at ?? now)
    const SILENT = 5 * 60_000
    const STALL = 10 * 60_000
    if (heldFor >= SILENT) {
      const m = Math.floor(heldFor / 60000)
      const bad = heldFor >= STALL
      return {
        state: bad ? "stalled" : "slow",
        tone: bad ? "bad" : "warn",
        headline: bad ? `Stalled — stage ${key} held for ${m}m` : `Slow — stage ${key} held for ${m}m`,
        detail: bad
          ? `No progress past the 10m budget. The node may be dead rather than slow. Probe before re-dispatching, or a live node and a fresh one will both write here.`
          : `Still inside the 10m budget. If it goes over, treat the node as dead rather than slow.`,
      }
    }
  }

  const fails = r.events.filter((e) => e.k === "gate" && e.state === "fail" && now - e.t < 30 * 60_000)
  if (fails.length >= 3) {
    const recentFails = fails.slice(-3)
    const same = new Set(recentFails.map((e) => e.cmd)).size === 1
    if (same)
      return {
        state: "stuck",
        tone: "bad",
        headline: "Stuck â€” same failure 3 times",
        detail: `The loop will stop here. Repeatedly failing: \`${recentFails[0].cmd.slice(0, 90)}\``,
      }
  }

  const cheat = r.events.find((e) => e.k === "cheat")
  if (cheat && recent(cheat))
    return {
      state: "blocked",
      tone: "bad",
      headline: "Blocked â€” test weakening rejected",
      detail: `An edit to ${cheat.path} was refused because it would have made a gate green without the behaviour existing.`,
    }

  const nodes = r.events.filter((e) => e.k === "node")
  const node = nodes[nodes.length - 1]
  const codeOk = l.gates.code.state === "pass" && l.gates.code.at > l.lastEditAt
  const visualOk = l.gates.visual.state === "pass" && l.gates.visual.at > l.lastEditAt
  const visualNeeded = l.uiTouched && !l.waivers.some((w) => w.gate === "visual")
  const gatesOk = codeOk && (!visualNeeded || visualOk)
  const verdict = [...r.events].reverse().find((e) => e.k === "verdict")

  if (gatesOk && verdict?.value === "ship")
    return { state: "done", tone: "ok", headline: "Ready to commit", detail: "Gates pass and review returned ship." }
  if (gatesOk)
    return { state: "review", tone: "ok", headline: "Gates pass â€” awaiting review", detail: `Last node: ${node?.role ?? "none dispatched"}.` }
  if (node)
    return {
      state: "running",
      tone: "info",
      headline: `In ${node.role}${node.rung ? ` (rung ${node.rung})` : ""}`,
      detail: node.desc || "Node dispatched.",
    }
  if (last && now - last.t < ALIVE_MS)
    return { state: "starting", tone: "info", headline: "Session alive", detail: "No node dispatched yet." }
  return {
    state: "stopped",
    tone: "muted",
    headline: "Stopped",
    detail: `Last activity ${Math.round((now - r.lastEventAt) / 1000)}s ago. History below.`,
  }
}

const adaptersFor = (repoPath) => {
  const out = []
  const dir = join(repoPath, ".loop", "adapters")
  if (existsSync(dir)) {
    try {
      for (const f of readdirSync(dir)) if (f.endsWith(".json")) out.push({ name: f.replace(/\.json$/, ""), file: join(dir, f) })
    } catch {}
  }
  const single = join(repoPath, ".loop", "adapter.json")
  if (existsSync(single)) out.push({ name: "default", file: single })
  let active = ""
  try {
    const p = join(repoPath, ".loop", "active-adapter")
    if (existsSync(p)) active = readFileSync(p, "utf8").trim()
  } catch {}

  // The switcher is a write control, so show what you are switching TO.
  // A name alone gives no way to tell a strict adapter from a permissive one
  // before committing to it. Summarise each candidate; never fail the list on
  // one malformed adapter file.
  for (const a of out) {
    try {
      const j = JSON.parse(readFileSync(a.file, "utf8"))
      a.riskFloor = j.floorRisk ?? j.riskFloor ?? null
      a.visualRequired = j.visualRequired ?? null
      a.mandatoryStages = Array.isArray(j.mandatoryStages) ? j.mandatoryStages : []
      a.ruleCount = Array.isArray(j.forbidden) ? j.forbidden.length : 0
    } catch {
      a.riskFloor = null
      a.visualRequired = null
      a.mandatoryStages = []
      a.ruleCount = null
      a.unreadable = true
    }
  }
  out.sort((a, b) => a.name.localeCompare(b.name))
  const current = out.find((a) => a.name === active) ?? out[0] ?? null
  return {
    list: out.map((a) => ({
      name: a.name,
      file: a.file,
      active: current ? a.name === current.name : false,
      riskFloor: a.riskFloor,
      visualRequired: a.visualRequired,
      mandatoryStages: a.mandatoryStages,
      ruleCount: a.ruleCount,
      unreadable: a.unreadable === true,
    })),
    active: current ? current.name : "",
  }
}

function snapshot() {
  const repos = []
  const now = Date.now()
  for (const r of runs.values()) {
    if (!r.ledger) continue
    let repo = repos.find((x) => x.repoHash === r.repoHash)
    if (!repo) {
      repo = { repoHash: r.repoHash, repoName: r.ledger.repoName, repo: r.ledger.repo, sessions: [], adapters: adaptersFor(r.ledger.repo) }
      repos.push(repo)
    }
    repo.adapters = adaptersFor(r.ledger.repo)
    repo.sessions.push({
      id: r.id,
      sid: r.sid,
      status: synthesise(r),
      alive: now - Math.max(r.lastEventAt, r.ledger.startedAt ?? 0) < ALIVE_MS,
      lastEventAt: r.lastEventAt,
      startedAt: r.ledger.startedAt,
      gates: r.ledger.gates,
      visualRequired: r.ledger.uiTouched && !r.ledger.waivers.some((w) => w.gate === "visual"),
      lastEditAt: r.ledger.lastEditAt,
      testEdits: r.ledger.testEditsSinceGreen,
      waivers: r.ledger.waivers,
      denials: r.ledger.denials.slice(-8),
      limits: r.events.filter((e) => e.k === "limit").slice(-8),
      todos: [...r.events].reverse().find((e) => e.k === "todo")?.todos ?? [],
      stages: r.ledger.stages ?? {},
      mcp: r.ledger.mcp ?? {},
      adapter: r.ledger.adapter ?? null,
      riskDeclared: r.ledger.riskDeclared ?? "",
      riskFloor: r.ledger.riskFloor ?? "medium",
      riskCats: r.ledger.riskCats ?? [],
      specialists: Object.values(r.ledger.stages ?? {}).flatMap((s) => s.skills ?? []),
      narr: r.narr,
      narrState: r.narrState,
      events: r.events.slice(-160),
    })
  }
  for (const repo of repos) repo.sessions.sort((a, b) => b.startedAt - a.startedAt)
  repos.sort((a, b) => b.sessions[0].startedAt - a.sessions[0].startedAt)
  return { repos, narrateEnabled: NARRATE_ALLOWED, publicUrl: (() => { try { return existsSync(PUBLIC_URL_FILE) ? readFileSync(PUBLIC_URL_FILE, "utf8").trim() : "" } catch { return "" } })() }
}

const broadcast = () => {
  const data = `data: ${JSON.stringify(snapshot())}\n\n`
  for (const c of clients) {
    try {
      c.write(data)
    } catch {}
  }
}

function opencodeBin() {
  const base = join(process.env.APPDATA ?? "", "npm", "node_modules")
  for (const rel of ["opencode-ai/bin/opencode.exe", "opencode-ai/node_modules/opencode-windows-x64/bin/opencode.exe"]) {
    const p = join(base, rel)
    if (existsSync(p)) return p
  }
  return null
}

function narrate(repoHash, sid) {
  const r = getRun(repoHash, sid)
  if (!r) return Promise.reject(new Error("no such run"))
  const led = r.ledger
  const bits = [
    `A software loop-engine run is in progress. Report where it is, in at most 120 words. Plain prose, no headers, no lists.`,
    ``,
    `Repository: ${led.repoName}`,
    `Status: ${synthesise(r).headline} â€” ${synthesise(r).detail}`,
    `Code gate: ${led.gates.code.state} (${led.gates.code.command.slice(0, 80) || "not run"})`,
    `Visual gate: ${led.gates.visual.state}${led.uiTouched ? " (UI files were touched)" : " (no UI files touched)"}`,
  ]
  const todos = [...r.events].reverse().find((e) => e.k === "todo")?.todos
  if (todos?.length) {
    const done = todos.filter((t) => t.s === "completed").length
    const cur = todos.find((t) => t.s === "in_progress")
    bits.push(`Todos: ${done}/${todos.length} complete. In progress: ${cur?.c ?? "none"}. Next: ${(todos.find((t) => t.s === "pending") ?? {}).c ?? "none"}`)
  }
  const nodes = r.events.filter((e) => e.k === "node")
  if (nodes.length) bits.push(`Nodes dispatched: ${nodes.map((e) => e.role).join(", ")}`)
  const lim = (led.limits ?? []).slice(-3)
  for (const l of lim) bits.push(`Rate limit (${l.cls}): ${String(l.detail).slice(0, 120)}`)
  const fails = r.events.filter((e) => e.k === "gate" && e.state === "fail").slice(-3)
  for (const f of fails) bits.push(`Failing gate command: ${f.cmd.slice(0, 120)}`)

  const bin = opencodeBin()
  if (!bin) return Promise.reject(new Error("opencode binary not found"))

  return new Promise((resolve, reject) => {
    const child = spawn(
      bin,
      ["run", "--standalone", "--model", NARRATOR_MODEL, "--agent", "loop-scribe", bits.join("\n")],
      {
        env: { ...process.env, OPENCODE_LOOP_NARRATOR: "1", NO_COLOR: "1" },
        cwd: led.repo,
        windowsHide: true,
      },
    )
    let out = ""
    let err = ""
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {}
      reject(new Error("narrator timed out"))
    }, 90_000)
    child.stdout.on("data", (d) => (out += d.toString()))
    child.stderr.on("data", (d) => (err += d.toString()))
    child.on("error", (e) => {
      clearTimeout(timer)
      reject(e)
    })
    child.on("close", (code) => {
      clearTimeout(timer)
      if (code === 0 && out.trim()) resolve(out.trim())
      else reject(new Error(err.trim().slice(0, 300) || `narrator exited ${code}`))
    })
  })
}

const readBody = (req) =>
  new Promise((resolve) => {
    let d = ""
    req.on("data", (c) => {
      d += c
      if (d.length > 1e6) req.destroy()
    })
    req.on("end", () => resolve(d))
  })

const authed = (url, req) => {
  const h = req.headers.authorization ?? ""
  if (h.startsWith("Bearer ") && safeEqual(h.slice(7).trim(), TOKEN)) return true
  const t = url.searchParams.get("t")
  if (t && safeEqual(t, TOKEN)) return true
  const cookie = req.headers.cookie ?? ""
  const m = /(?:^|;\s*)lp=([^;]+)/.exec(cookie)
  return !!m && safeEqual(decodeURIComponent(m[1]), TOKEN)
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`)
  const p = url.pathname

  if (p === "/health")
    return json(res, 200, { service: "loop-portal", ok: true, sessions: aliveCount(), narrate: NARRATE_ALLOWED })

  if (p === "/" && req.method === "GET") {
    if (!TOKEN) return text(res, 500, "no token")
    if (url.searchParams.get("t") && safeEqual(url.searchParams.get("t"), TOKEN)) {
      res.writeHead(302, { "Set-Cookie": `lp=${encodeURIComponent(TOKEN)}; Path=/; HttpOnly; SameSite=Lax`, Location: "/" })
      return res.end()
    }
    if (!authed(url, req)) return text(res, 401, "unauthorised")
    try {
      const html = readFileSync(UI_FILE, "utf8")
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" })
      return res.end(html)
    } catch {
      return text(res, 500, `ui missing at ${UI_FILE}`)
    }
  }

  if (p === "/api/stream" && req.method === "GET") {
    if (!authed(url, req)) return text(res, 401, "unauthorised")
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    })
    res.write(`data: ${JSON.stringify(snapshot())}\n\n`)
    clients.add(res)
    req.on("close", () => clients.delete(res))
    return
  }

  if (p === "/api/runs" && req.method === "GET") {
    if (!authed(url, req)) return text(res, 401, "unauthorised")
    return json(res, 200, snapshot())
  }

  if (p === "/api/narrate" && req.method === "POST") {
    if (!authed(url, req)) return text(res, 401, "unauthorised")
    if (!NARRATE_ALLOWED)
      return json(res, 403, {
        error: "narration disabled",
        hint: "The narrator spawns a model process on this machine. It is off by default. Start the daemon with LOOP_PORTAL_NARRATE=1 to enable it.",
      })
    const body = JSON.parse((await readBody(req)) || "{}")
    const k = key(body.repoHash, body.sid)
    if (narrating.has(k)) return json(res, 409, { error: "already narrating" })
    const r = getRun(body.repoHash, body.sid)
    if (!r) return json(res, 404, { error: "no such run" })
    narrating.add(k)
    r.narrState = "busy"
    broadcast()
    try {
      r.narr = { at: Date.now(), text: await narrate(body.repoHash, body.sid) }
      r.narrState = "ok"
    } catch (e) {
      r.narrState = "error"
      r.narr = { at: Date.now(), text: "", error: String(e?.message ?? e).slice(0, 300) }
    } finally {
      narrating.delete(k)
      broadcast()
    }
    return json(res, 200, { ok: true, narr: r.narr, narrState: r.narrState })
  }

  if (p === "/api/adapter" && req.method === "POST") {
    if (!authed(url, req)) return text(res, 401, "unauthorised")
    let body = {}
    try {
      body = JSON.parse((await readBody(req)) || "{}")
    } catch {
      return json(res, 400, { error: "bad json" })
    }
    if (!body.repo || !body.name) return json(res, 400, { error: "repo and name are required" })
    if (!/^[A-Za-z]:[\\/]/.test(String(body.repo)) || String(body.repo).includes(".."))
      return json(res, 400, { error: "repo must be an absolute path with no parent traversal" })
    const dir = join(body.repo, ".loop", "adapters")
    const single = join(body.repo, ".loop", "adapter.json")
    const exists =
      existsSync(join(dir, `${body.name}.json`)) || (body.name === "default" && existsSync(single))
    if (!exists) return json(res, 404, { error: `no adapter named "${body.name}" in ${body.repo}` })
    try {
      mkdirSync(join(body.repo, ".loop"), { recursive: true })
      writeFileSync(join(body.repo, ".loop", "active-adapter"), body.name, "utf8")
      log(`adapter switched to ${body.name} for ${body.repo}`)
    } catch (e) {
      return json(res, 500, { error: `could not write active-adapter: ${e.message}` })
    }
    scan()
    const payload = snapshot()
    broadcast()
    return json(res, 200, { ok: true, active: body.name, repos: payload.repos })
  }

  return text(res, 404, "not found")
})

const json = (res, code, obj) => {
  res.writeHead(code, { "Content-Type": "application/json" })
  res.end(JSON.stringify(obj))
}
const text = (res, code, s) => {
  res.writeHead(code, { "Content-Type": "text/plain" })
  res.end(s)
}

scan()
setInterval(() => {
  scan()
}, 1000)
setInterval(broadcast, 2000)
let emptySince = 0
setInterval(() => {
  if (PERSIST) return
  if (aliveCount() === 0) {
    if (!emptySince) emptySince = Date.now()
    else if (Date.now() - emptySince > REAP_GRACE_MS) {
      log("no live sessions for " + REAP_GRACE_MS + "ms, shutting down")
      process.exit(0)
    }
  } else {
    emptySince = 0
  }
}, 5000)

// Two opencode windows can race here: each plugin instance has its own
// ensurePortal, and both health-checks see "not healthy" before either has bound
// the port. The loser must die, not linger as a process that serves nothing.
server.on("error", (e) => {
  if (e && e.code === "EADDRINUSE") {
    log("port " + PORT + " already served by another instance; exiting")
    process.exit(0)
  }
  log("server error: " + (e?.message ?? e))
  process.exit(1)
})

server.listen(PORT, HOST, () => {
  log("listening on http://" + HOST + ":" + PORT + " narrate=" + NARRATE_ALLOWED + " persist=" + PERSIST)
  log("narrator model: " + NARRATOR_MODEL)
})
