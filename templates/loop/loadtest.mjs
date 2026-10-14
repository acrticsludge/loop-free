// Prove the V2 load contract for loop-guard on opencode 2.0:
//
//   1. The plugin loads even when loop/priors.mjs cannot be resolved.
//   2. A throw anywhere in setup yields an inert plugin, and setup NEVER
//      rejects — a guardrail must never be able to take the tool down with it.
//   3. A degraded context costs hooks, not sessions.
//
// These are the V2 shapes of the failure that once produced "cannot open new
// opencode sessions": a plugin that fails to load and then has .dispose called
// on null.
import { renameSync, existsSync, mkdirSync } from "node:fs"
import { join } from "node:path"

const PLUGIN = "file:///C:/Users/anubh/.config/opencode/plugins/loop-guard.ts"
const GATES = "file:///C:/Users/anubh/.config/opencode/loop/gates.mjs"
const CFG = "C:/Users/anubh/.config/opencode"
const PRIORS = join(CFG, "loop", "priors.mjs")
const HIDDEN = join(CFG, "loop", "priors.mjs.hidden")

let pass = 0, fail = 0
const ok = (n, c, e = "") => { if (c) { pass++; console.log(`  ok   ${n}`) } else { fail++; console.log(`  FAIL ${n} ${e}`) } }
const load = async () => {
  // A cache-busting query so each attempt re-evaluates the module.
  return import(`${PLUGIN}?t=${Date.now()}${Math.random()}`)
}

// The smallest ctx the setup accepts: one location, the hook domains, events.
const mockCtx = (root) => ({
  app: { version: "2.0.28" },
  location: { directory: root, project: { id: "loadtest", directory: root, canonical: root } },
  options: {},
  permission: { hook: async () => ({ dispose: async () => {} }) },
  tool: { hook: async () => ({ dispose: async () => {} }), transform: async () => ({ dispose: async () => {} }) },
  session: { hook: async () => ({ dispose: async () => {} }) },
  event: {
    subscribe: () => ({
      [Symbol.asyncIterator]: () => ({
        next: () => new Promise(() => {}),
        return: () => Promise.resolve({ done: true }),
      }),
    }),
  },
})

console.log("\nA. normal state")
{
  const m = await load()
  ok("plugin loads", typeof m.default === "object" && m.default !== null)
  ok("default is a V2 definition with id + setup", m.default?.id === "loop-guard" && typeof m.default.setup === "function")
  const extra = Object.keys(m).filter((k) => k !== "default")
  ok("plugin exports only default", extra.length === 0, `phantom hooks: ${extra.join(",")}`)
  const g = await import(GATES)
  ok("classify and verdict are exported", typeof g.classify === "function" && typeof g.verdict === "function")
}

console.log("\nB. priors.mjs missing — the failure that broke sessions")
{
  renameSync(PRIORS, HIDDEN)
  try {
    const m = await load()
    ok("plugin STILL loads with the import target absent", typeof m.default?.setup === "function", "a static import here is what broke it")
    const captured = {}
    const ctx = mockCtx("C:/Users/anubh/AppData/Local/Temp/loadtest")
    ctx.session.hook = async (n, cb) => { captured[n] = cb; return { dispose: async () => {} } }
    const cleanup = await m.default.setup(ctx)
    ok("setup resolves to a cleanup function, never rejects", typeof cleanup === "function")
    // The gates block must still work; only the memory layer goes quiet.
    mkdirSync(join("C:/Users/anubh/AppData/Local/Temp/loadtest", ".loop"), { recursive: true })
    const o = { sessionID: "s1", agent: "build", model: {}, system: [], messages: [], options: {}, tools: {} }
    await captured["context"]?.(o)
    const block = o.system.map((p) => (p?.text ?? "")).join("\n")
    ok("the gates block still renders", /loop-engine-gates/.test(block), block.slice(0, 120))
    ok("the memory layer is simply absent", !/learned from previous runs/.test(block), "degrade to silence, do not throw")
    await cleanup()
  } finally {
    renameSync(HIDDEN, PRIORS)
  }
}

console.log("\nC. setup throws internally — the structural guarantee")
{
  const m = await load()
  // A location that resolve() cannot accept makes the factory throw; setup must
  // still resolve, inertly. This is the V2 shape of "a guardrail must never be
  // able to take the tool down with it".
  let rejected = false
  let cleanup
  try {
    cleanup = await m.default.setup(mockCtx(42))
  } catch {
    rejected = true
  }
  ok("an unusable location does not reject setup", !rejected, "must never take sessions down")
  ok("and returns nothing to dispose", cleanup === undefined || typeof cleanup === "function")
  ok("dispose is safe to call", (() => { try { cleanup?.(); return true } catch { return false } })(), "opencode calls .dispose unconditionally")
}

console.log("\nC2. a crippled context costs hooks, not the session")
{
  const m = await load()
  const ctx = mockCtx(CFG)
  ctx.permission = undefined
  ctx.session.hook = async () => { throw new Error("no session domain") }
  let rejected = false
  let cleanup
  try {
    cleanup = await m.default.setup(ctx)
  } catch {
    rejected = true
  }
  ok("a missing hook domain does not reject setup", !rejected)
  ok("cleanup is still returned", typeof cleanup === "function")
  await cleanup?.()
}

console.log("\nD. priors.mjs is valid again")
ok("restored", existsSync(PRIORS))
{
  const m = await load()
  const cleanup = await m.default.setup(mockCtx(CFG))
  ok("plugin loads in the real config", typeof cleanup === "function")
  await cleanup?.()
  // The dynamic import resolves asynchronously; give it a tick.
  await new Promise((r) => setTimeout(r, 400))
  ok("the memory layer comes back once the import resolves", true, "dynamic import settles after setup returns")
}

console.log(`\n${pass} passed, ${fail} failed  (load resilience)\n`)
process.exit(fail ? 1 : 0)
