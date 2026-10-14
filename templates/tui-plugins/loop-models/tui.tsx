// TUI half of the loop-models plugin.
//
// `/loop-free-models`         -- the tabbed ladder page
// `/loop-free-models-classic` -- the same editor through plain dialogs
//
// A tab per subagent, one row per rung under it, the model beside each. Enter
// (or a click) opens the native searchable select over the selected rung --
// the same model registry `/models` reads -- and the choice is written back
// to that rung's agent file so the ladder itself changes. Esc, q, or the
// [<- back] button returns to wherever the command was invoked from.
//
// Hard-won details, kept so they are not relearned:
//   - `enabled` must be a function; a boolean is evaluated once inside the
//     layer factory, and the factory only re-runs on tracked reads.
//   - a command `run` returning `false` does not consume the key, so these
//     bindings fall through instead of stealing keys from the rest of the TUI.
//   - Solid only tracks reads made inside JSX; assumes accessors, not captured
//     values, for anything that must update.
//   - the return route must be snapshotted with a spread: router.current()
//     hands back a live object that mutates on navigation.
import fs from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { createSignal } from "solid-js"

const AGENT_DIR = join(homedir(), ".config", "opencode", "agent")
const PAGE = "loop-free-ladder"

// Display order for the known ladder; unknown roles sort after, alphabetically.
const ROLE_ORDER = [
  "loop-free-implement",
  "loop-free-review",
  "loop-free-verify-code",
  "loop-free-verify-visual",
  "loop-free-harden",
  "loop-free-gather",
  "loop-free-scribe",
]
const RUNG_RE = /^loop-free-(.+?)-(\d+)$/

type Rung = { id: string; rung: number }
type Role = { base: string; label: string; description: string; rungs: Rung[] }

export default {
  id: "loop-models",
  setup(ctx: any) {
    // Defensive: without a TUI context there is nothing to edit.
    if (!ctx?.ui?.router?.register || !ctx?.ui?.slot || !ctx?.keymap?.layer || !ctx?.data?.location?.agent) return

    const agents = (): any[] => ctx.data.location.agent.list() ?? []
    const models = (): any[] => ctx.data.location.model.list() ?? []
    const overrides = new Map<string, string>()

    const modelOf = (agentId: string): string => {
      const patched = overrides.get(agentId)
      if (patched) return patched
      const model = agents().find((a) => a?.id === agentId)?.model
      if (!model) return "not loaded"
      const variant = model.variant ? `#${model.variant}` : ""
      return `${model.providerID ?? "?"}/${model.id ?? "?"}${variant}`
    }

    const roles = (): Role[] => {
      const groups = new Map<string, Rung[]>()
      for (const agent of agents()) {
        if (typeof agent?.id !== "string" || !agent.id.startsWith("loop-free-")) continue
        const match = agent.id.match(RUNG_RE)
        const base = match ? `loop-free-${match[1]}` : agent.id
        const rung = match ? Number(match[2]) : 0
        if (!groups.has(base)) groups.set(base, [])
        groups.get(base)!.push({ id: agent.id, rung })
      }
      const names = [...groups.keys()].sort((a, b) => {
        const ia = ROLE_ORDER.indexOf(a)
        const ib = ROLE_ORDER.indexOf(b)
        const ra = ia < 0 ? ROLE_ORDER.length : ia
        const rb = ib < 0 ? ROLE_ORDER.length : ib
        return ra - rb || a.localeCompare(b)
      })
      return names.map((base) => {
        const rungs = (groups.get(base) ?? []).sort((a, b) => a.rung - b.rung)
        const first = agents().find((a) => a?.id === rungs[0]?.id)
        return {
          base,
          label: base.replace(/^loop-free-/, ""),
          description: String(first?.description ?? ""),
          rungs,
        }
      })
    }

    const [tab, setTab] = createSignal(0)
    const [rung, setRung] = createSignal(0)
    const [picking, setPicking] = createSignal(false)
    let returnRoute: any = null

    // Imperative by design: router.current() is not a reactive source.
    const onPage = (): boolean => {
      try {
        const route = ctx.ui.router.current()
        return route?.type === "plugin" && route.name === PAGE
      } catch {
        return false
      }
    }

    const searchModels = (query: string, options: readonly any[]): readonly any[] => {
      const needle = query.trim().toLowerCase()
      if (!needle) return options
      return options.filter((option) =>
        `${option.title} ${option.description ?? ""}`.toLowerCase().includes(needle),
      )
    }

    const writeModel = (agentId: string, model: string): void => {
      const file = join(AGENT_DIR, `${agentId}.md`)
      const text = fs.readFileSync(file, "utf8")
      if (!/^model:.*$/m.test(text)) throw new Error(`no model line in ${agentId}.md`)
      fs.writeFileSync(file, text.replace(/^model:.*$/m, `model: ${model}`))
    }

    const pickModel = async (agentId: string): Promise<void> => {
      if (picking()) return
      setPicking(true)
      try {
        try {
          await ctx.data.location.model.sync?.()
        } catch {}
        const list = models().filter((m) => m?.enabled !== false)
        if (!list.length) {
          ctx.ui.toast.show({ message: "No models in the registry yet", variant: "warning" })
          return
        }
        const current = modelOf(agentId)
        const options = list.map((m) => {
          const modelID = m.modelID ?? m.id
          const status = m.status && m.status !== "active" ? `  (${m.status})` : ""
          return {
            title: m.name ?? String(modelID),
            description: `${m.providerID}/${modelID}${status}`,
            value: `${m.providerID}/${modelID}`,
          }
        })
        const picked = await ctx.ui.dialog.select<string>({
          title: `Model for ${agentId}`,
          placeholder: `current: ${current} — type to search`,
          options,
          current,
          search: searchModels,
        })
        if (!picked || picked === current) return
        try {
          writeModel(agentId, picked)
          overrides.set(agentId, picked)
          ctx.ui.toast.show({ title: "Ladder updated", message: `${agentId} → ${picked}`, variant: "success" })
        } catch (error: any) {
          ctx.ui.toast.show({ title: "Could not write the agent file", message: String(error?.message ?? error), variant: "error" })
        }
      } finally {
        setPicking(false)
      }
    }

    const leave = (): void => {
      try {
        ctx.ui.dialog.clear?.()
        if (returnRoute) ctx.ui.router.navigate(returnRoute)
        else ctx.ui.router.navigate({ type: "home" })
      } catch {
        try {
          ctx.ui.router.navigate({ type: "home" })
        } catch {}
      }
    }

    const openPage = (): void => {
      try {
        if (onPage()) {
          leave()
          return
        }
        // Snapshot, do not store the live route object: current() hands back
        // state that mutates in place on navigation, so keeping the reference
        // makes "back" point at the page itself and the navigate is a no-op.
        // The builtin /stats page spreads the route for exactly this reason.
        returnRoute = { ...(ctx.ui.router.current() ?? { type: "home" }) }
        ctx.ui.dialog.clear?.()
        ctx.ui.router.navigate({ type: "plugin", name: PAGE })
      } catch {}
    }

    const stopPage = ctx.ui.router.register({
      name: PAGE,
      render: () => {
        // Accessors only. Every read in this component happens inside JSX so
        // Solid tracks it; reads hoisted into the body would never update.
        const all = (): Role[] => roles()
        const tabIndex = (): number => {
          const count = all().length
          return count ? Math.min(tab(), count - 1) : 0
        }
        const currentRole = (): Role | undefined => all()[tabIndex()]
        const rungIndex = (): number => {
          const count = currentRole()?.rungs.length ?? 0
          return count ? Math.min(rung(), count - 1) : 0
        }
        const accent = () => ctx.theme?.hue?.interactive?.[200]
        const dim = () => ctx.theme?.text?.subdued
        const base = () => ctx.theme?.text?.base
        return (
          <box flexDirection="column" gap={1} paddingLeft={2} paddingRight={2} paddingTop={1}>
            <box flexDirection="row" justifyContent="space-between" flexShrink={0}>
              <text fg={accent()}>loop-free ladder</text>
              <box onMouseUp={() => leave()}>
                <text fg={accent()}>[← back]</text>
              </box>
            </box>
            <box flexDirection="row" gap={2} flexShrink={0}>
              {all().map((entry, i) => (
                <box
                  onMouseUp={() => {
                    setTab(i)
                    setRung(0)
                  }}
                >
                  <text fg={i === tabIndex() ? accent() : dim()}>
                    {i === tabIndex() ? `[${entry.label}]` : ` ${entry.label} `}
                  </text>
                </box>
              ))}
            </box>
            <text fg={dim()}>{currentRole()?.description ?? ""}</text>
            <box flexDirection="column" flexShrink={0}>
              {(currentRole()?.rungs ?? []).map((item, i) => (
                <box
                  flexDirection="row"
                  gap={2}
                  flexShrink={0}
                  onMouseUp={() => {
                    setRung(i)
                    void pickModel(item.id)
                  }}
                >
                  <text fg={i === rungIndex() ? accent() : dim()}>{i === rungIndex() ? "▸" : " "}</text>
                  <text fg={i === rungIndex() ? base() : dim()}>
                    {(item.rung ? `rung ${item.rung}` : "single").padEnd(8)}
                  </text>
                  <text fg={i === rungIndex() ? accent() : dim()}>{modelOf(item.id)}</text>
                  <text fg={accent()}>[change]</text>
                </box>
              ))}
            </box>
            <text fg={dim()}>click a subagent tab, click a rung to change its model · [← back] to leave</text>
          </box>
        )
      },
    })

    const classic = async (): Promise<void> => {
      try {
        await ctx.data.location.agent.sync?.()
      } catch {}
      while (true) {
        const all = roles()
        if (!all.length) {
          ctx.ui.toast.show({ message: "No loop-free agents found", variant: "warning" })
          return
        }
        const roleBase = await ctx.ui.dialog.select<string>({
          title: "Loop-free ladder — pick a subagent",
          options: all.map((role) => ({
            title: role.label,
            description: role.rungs.map((item) => `${item.rung ? `rung ${item.rung}` : "single"}: ${modelOf(item.id)}`).join("   ·   "),
            value: role.base,
          })),
        })
        if (!roleBase) return
        const role = roles().find((entry) => entry.base === roleBase)
        if (!role) continue
        while (true) {
          const rungId = await ctx.ui.dialog.select<string>({
            title: `${role.label} — pick a rung`,
            options: role.rungs.map((item) => ({
              title: item.rung ? `Rung ${item.rung} — ${item.id}` : item.id,
              description: modelOf(item.id),
              value: item.id,
            })),
          })
          if (!rungId) break
          await pickModel(rungId)
        }
      }
    }

    // Command layer, created inside this render scope like the builtin /stats
    // plugin.
    const stopSlot = ctx.ui.slot({
      append: "app",
      render: () => {
        ctx.keymap.layer(() => ({
          mode: "global",
          commands: [
            {
              id: "loop-models.open",
              title: "Loop-free ladder",
              description: "Edit which model each loop-free rung runs",
              group: "Loop",
              palette: true,
              slash: { name: "loop-free-models" },
              run: () => openPage(),
            },
            {
              id: "loop-models.classic",
              title: "Loop-free ladder (classic)",
              description: "Edit the ladder through plain dialogs",
              group: "Loop",
              palette: true,
              slash: { name: "loop-free-models-classic" },
              run: () => void classic(),
            },
          ],
        }))
        ctx.keymap.layer(() => ({
          mode: "global",
          enabled: () => !picking(),
          commands: [
            {
              bind: "right,l",
              title: "Next subagent",
              group: "Loop ladder",
              run: () => {
                if (!onPage() || picking()) return false
                const count = roles().length
                if (count) {
                  setTab((i) => (i + 1 + count) % count)
                  setRung(0)
                }
              },
            },
            {
              bind: "left,h",
              title: "Previous subagent",
              group: "Loop ladder",
              run: () => {
                if (!onPage() || picking()) return false
                const count = roles().length
                if (count) {
                  setTab((i) => (i - 1 + count) % count)
                  setRung(0)
                }
              },
            },
            {
              bind: "down,j",
              title: "Next rung",
              group: "Loop ladder",
              run: () => {
                if (!onPage() || picking()) return false
                const role = roles()[Math.min(tab(), Math.max(0, roles().length - 1))]
                const count = role?.rungs.length ?? 0
                if (count) setRung((i) => (i + 1) % count)
              },
            },
            {
              bind: "up,k",
              title: "Previous rung",
              group: "Loop ladder",
              run: () => {
                if (!onPage() || picking()) return false
                const role = roles()[Math.min(tab(), Math.max(0, roles().length - 1))]
                const count = role?.rungs.length ?? 0
                if (count) setRung((i) => (i - 1 + count) % count)
              },
            },
            {
              bind: "return",
              title: "Change model",
              group: "Loop ladder",
              run: () => {
                if (!onPage() || picking()) return false
                const role = roles()[Math.min(tab(), Math.max(0, roles().length - 1))]
                const target = role?.rungs[Math.min(rung(), (role?.rungs.length ?? 1) - 1)]
                if (target) void pickModel(target.id)
              },
            },
            {
              bind: "escape,q",
              title: "Back",
              group: "Loop ladder",
              run: () => {
                if (!onPage() || picking()) return false
                leave()
              },
            },
          ],
        }))
        return null as any
      },
    })

    return () => {
      try {
        stopSlot?.()
      } catch {}
      try {
        stopPage?.()
      } catch {}
    }
  },
}
