// TUI half of the tok-speed plugin: a live tokens/second readout in the
// session sidebar (`sidebar.content`, appended under the built-ins).
//
// The streaming backbone is `session.text.delta` / `session.reasoning.delta`
// (ephemeral, one fragment at a time). They carry text, not token counts, so
// the rate is an estimate: characters per second over a rolling window divided
// by CHARS_PER_TOKEN. Fast-model output runs roughly 4 characters per token for
// prose and denser for code, so 4.0 keeps the number comparable to provider
// accounting without overstating it.
//
// Display states:
//   streaming  -- accent, the live rate
//   paused     -- the last rate, dimmed, so a tool call never blanks the
//                 readout (a "--" while the model is working looks broken)
//   no samples -- "--"
import { createSignal } from "solid-js"

const WINDOW_MS = 2500
const CHARS_PER_TOKEN = 4
const TICK_MS = 200
const MIN_TPS = 0.5

type Reading = { tps: number; fresh: boolean }

export default {
  id: "tok-speed",
  setup(ctx: any) {
    // Defensive: without a TUI context there is nothing to render.
    if (!ctx?.ui?.slot || !ctx?.data?.on) return

    const [readings, setReadings] = createSignal<Record<string, Reading>>({})
    const windows: Record<string, Array<[number, number]>> = {}
    const pending: Record<string, number> = {}

    const note = (event: any, chars: number) => {
      const sid = (event?.data ?? event)?.sessionID
      if (!sid || chars <= 0) return
      pending[sid] = (pending[sid] ?? 0) + chars
    }

    const offs = [
      ctx.data.on("session.text.delta", (e: any) => note(e, String((e?.data ?? e)?.delta ?? "").length)),
      ctx.data.on("session.reasoning.delta", (e: any) => note(e, String((e?.data ?? e)?.delta ?? "").length)),
    ]

    const clock = setInterval(() => {
      const now = Date.now()
      for (const sid of Object.keys(pending)) {
        const buf = windows[sid] ?? (windows[sid] = [])
        buf.push([now, pending[sid]])
        delete pending[sid]
      }
      const next: Record<string, Reading> = { ...readings() }
      for (const sid of Object.keys(windows)) {
        const buf = windows[sid]
        while (buf.length && now - buf[0][0] > WINDOW_MS) buf.shift()
        if (!buf.length) {
          // The stream drained: keep the last number, marked stale.
          if (next[sid]) next[sid] = { tps: next[sid].tps, fresh: false }
          delete windows[sid]
          continue
        }
        let chars = 0
        for (const sample of buf) chars += sample[1]
        const span = Math.max((now - buf[0][0]) / 1000, TICK_MS / 1000)
        const tps = chars / span / CHARS_PER_TOKEN
        if (tps > MIN_TPS) next[sid] = { tps, fresh: true }
        else if (next[sid]) next[sid] = { tps: next[sid].tps, fresh: false }
        else delete next[sid]
      }
      setReadings(next)
    }, TICK_MS)

    const stop = ctx.ui.slot({
      append: "sidebar.content",
      render: (input: { sessionID: string }) => {
        const row = readings()[input.sessionID]
        const label = !row ? "--" : row.tps >= 100 ? String(Math.round(row.tps)) : row.tps.toFixed(1)
        const fg = row?.fresh ? ctx.theme?.hue?.interactive?.[200] : ctx.theme?.text?.subdued
        return (
          <box flexDirection="row" flexShrink={0} gap={1}>
            <text fg={ctx.theme?.text?.base}>tok/s</text>
            <text fg={fg}>{label}</text>
          </box>
        )
      },
    })

    return () => {
      clearInterval(clock)
      for (const off of offs) {
        try {
          off?.()
        } catch {}
      }
      try {
        stop?.()
      } catch {}
    }
  },
}
