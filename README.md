# opencode-terminal-status

OpenCode v2 CLI plugin that mirrors iTerm2's official Claude Code integration:
a terminal tab **progress bar** plus a tab **subtitle status**, background-agent
aware.

| Agent state       | Progress bar (`OSC 9;4`) | Subtitle (`OSC 21337`)        |
| ----------------- | ------------------------ | ----------------------------- |
| Busy              | Indeterminate (green)    | `working`, green dot          |
| Waiting for input | Paused at 50% (orange)   | `waiting` + detail, orange    |
| Idle              | Cleared                  | `idle`, gray                  |
| Error             | Error (red)              | `error`, red                  |

The tab stays `working` until the whole visible session family (root plus
child subagents) is done. Only sessions visible in the current TUI (open
session or open tabs) drive the tab; other projects on the same server never
paint it.

## Requirements

- OpenCode v2.
- iTerm2 for the subtitle half. The progress bar also works in Ghostty,
  WezTerm, kitty (0.47+), and Windows Terminal.
- In iTerm2, enable `View → Toolbelt → Session Status` (and
  `Show status in tab subtitle`) to see the subtitle, sorting, and
  notify-on-change for free.

## Install

```bash
opencode plugin add github:Okxdd123/opencode-terminal-status
```

Then restart the TUI. tmux passthrough is handled transparently.

> Do not run this together with a local copy of the same plugin or with
> `opencode-terminal-progress`: two painters fight over one tab.

## Configuration

Language follows the macOS system language (same source as iTerm2's UI
language): Chinese UI gets Chinese labels, anything else gets the English
canonical values (`working`/`waiting`/`idle`, which also hit iTerm2's default
priority sorting).

| Variable                       | Effect                                              |
| ------------------------------ | --------------------------------------------------- |
| `OPENCODE_ITERM_STATUS=0`      | Disable the plugin entirely                         |
| `OPENCODE_ITERM_STATUS_LANG`   | `zh` or `en`, overrides auto detection              |
| `OPENCODE_ITERM_STATUS_DEBUG`  | `1` writes an event log to `$TMPDIR` for diagnosis  |

Texts and colors live at the top of `src/tui.ts`; empty string clears that
iTerm2 field.

## Develop

```bash
bun run build   # -> dist/
```

## License

[MIT](./LICENSE)
