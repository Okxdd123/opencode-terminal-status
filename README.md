# opencode-terminal-status

OpenCode v2 终端插件，对齐 iTerm2 官方 Claude Code 集成：终端标签页**进度条**加标签页**小字状态**，且能感知后台代理。

| Agent 状态 | 进度条（`OSC 9;4`） | 小字（`OSC 21337`）      |
| ---------- | ------------------ | ------------------------ |
| 忙碌       | 不定绿条           | `working`，绿点         |
| 等待确认   | 橘黄半格（50%）    | `waiting` 加详情，橘色  |
| 空闲       | 清除               | `idle`，灰色            |
| 出错       | 红条               | `error`，红色           |

可见会话家族（根会话加子代理）全部做完之前，标签页一直显示 `working`。只有当前 TUI 可见的会话才会画这个 tab，同 server 上的其它工程互不干扰。

## 环境要求

- OpenCode v2。
- 小字部分需要 iTerm2。进度条在 Ghostty、WezTerm、kitty（0.47+）、Windows Terminal 下同样可用。
- iTerm2 里打开 `View → Toolbelt → Session Status`（并勾选 `Show status in tab subtitle`），排序、Snooze、状态变化提醒免费即得。

## 安装

```bash
opencode plugin add github:Okxdd123/opencode-terminal-status
```

然后重启 TUI。tmux 透传已处理。

> 手动兜底（`plugin add github:` 坏掉时用，比如 2.0.27–2.0.28 上
> `package.json` 里有 `build` 脚本会触发 `git dep preparation failed`，
> 本仓自 v1.0.1 起把脚本改名 `build:dist` 绕开）：

```bash
git clone https://github.com/Okxdd123/opencode-terminal-status.git \
  ~/.config/opencode/plugins/opencode-terminal-status
```

> 不要和本地同款副本或 `opencode-terminal-progress` 同装：两个绘制者会打架。

## 配置

语言跟 macOS 系统语言走（和 iTerm2 界面语言同源）：中文系统显示中文标签，其它显示英文正典值（`working`/`waiting`/`idle`，同时吃到 iTerm2 默认优先级排序）。

| 变量                         | 作用                             |
| ---------------------------- | -------------------------------- |
| `OPENCODE_ITERM_STATUS=0`    | 完全禁用插件                     |
| `OPENCODE_ITERM_STATUS_LANG` | `zh` 或 `en`，覆盖自动判定       |
| `OPENCODE_ITERM_STATUS_DEBUG`| `1`，往 `$TMPDIR` 写事件诊断日志 |

文案和颜色在 `src/tui.ts` 顶部，空字符串即清除 iTerm2 对应字段。

## 开发

```bash
bun run build:dist   # -> dist/
```

## License

[MIT](./LICENSE)

---

# opencode-terminal-status (English)

OpenCode v2 CLI plugin mirroring iTerm2's official Claude Code integration:
a terminal tab **progress bar** plus a tab **subtitle status**, background-agent
aware.

| Agent state       | Progress bar (`OSC 9;4`) | Subtitle (`OSC 21337`)      |
| ----------------- | ------------------------ | --------------------------- |
| Busy              | Indeterminate (green)    | `working`, green dot        |
| Waiting for input | Paused at 50% (orange)   | `waiting` + detail, orange  |
| Idle              | Cleared                  | `idle`, gray                |
| Error             | Error (red)              | `error`, red                |

The tab stays `working` until the whole visible session family (root plus
child subagents) is done. Only sessions visible in the current TUI paint the
tab; other projects on the same server never interfere.

## Requirements

- OpenCode v2.
- iTerm2 for the subtitle half. The progress bar also works in Ghostty,
  WezTerm, kitty (0.47+), and Windows Terminal.
- In iTerm2, enable `View → Toolbelt → Session Status` (and
  `Show status in tab subtitle`) for sorting, snoozing, and
  notify-on-change for free.

## Install

```bash
opencode plugin add github:Okxdd123/opencode-terminal-status
```

Then restart the TUI. tmux passthrough is handled transparently.

> Manual fallback (also what to do while `plugin add github:` is broken,
> as on 2.0.27–2.0.28 where a `build` script in `package.json` trips
> `git dep preparation failed` — fixed here since v1.0.1 by shipping the
> script as `build:dist`):

```bash
git clone https://github.com/Okxdd123/opencode-terminal-status.git \
  ~/.config/opencode/plugins/opencode-terminal-status
```

> Do not run this together with a local copy of the same plugin or with
> `opencode-terminal-progress`: two painters fight over one tab.

## Configuration

Language follows the macOS system language (same source as iTerm2's UI
language): a Chinese system gets Chinese labels, anything else gets the
English canonical values (`working`/`waiting`/`idle`, which also hit iTerm2's
default priority sorting).

| Variable                       | Effect                                             |
| ------------------------------ | -------------------------------------------------- |
| `OPENCODE_ITERM_STATUS=0`      | Disable the plugin entirely                        |
| `OPENCODE_ITERM_STATUS_LANG`   | `zh` or `en`, overrides auto detection             |
| `OPENCODE_ITERM_STATUS_DEBUG`  | `1` writes an event log to `$TMPDIR` for diagnosis |

Texts and colors live at the top of `src/tui.ts`; empty string clears that
iTerm2 field.

## Develop

```bash
bun run build:dist   # -> dist/
```

## License

[MIT](./LICENSE)
