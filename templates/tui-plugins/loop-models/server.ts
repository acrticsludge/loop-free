// Server half of the loop-models plugin.
//
// OpenCode resolves two entrypoints for a local plugin directory:
// `<dir>/server` (the server plugin) and `<dir>/tui` (the TUI plugin). If the
// server entrypoint does not resolve, the whole entry is rejected, so this
// file exists to keep the pair valid. The actual work happens in `tui.tsx`.
export default {
  id: "loop-models",
  setup() {},
}
