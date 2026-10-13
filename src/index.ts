import { Plugin } from "@opencode/plugin"

// Server half: no server behavior. All work runs in the TUI process
// (src/tui.ts), the only side that owns the terminal.
export default Plugin.define({
  id: "opencode-terminal-status",
  async setup() {},
})
