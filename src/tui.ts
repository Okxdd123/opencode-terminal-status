import { Plugin } from "@opencode/plugin/tui"
import { execFileSync } from "child_process"
import { closeSync, openSync, writeSync } from "fs"

// opencode-terminal-status: terminal tab progress bar (OSC 9;4) +
// iTerm2 tab subtitle status (OSC 21337), background-agent aware:
// the tab shows working until the whole visible session family
// (root + child subagents) is done, mirroring iTerm2's official
// Claude Code integration.
//
// Tracking is global (every event updates the maps); painting is
// scoped to the visible family only, so other projects sharing the
// same server never paint this tab. Family roots resolve through the
// TUI store, falling back to a parentID chain walk via the client for
// sessions the store has not synced yet (e.g. a child's first event).
//
// State tracking is adapted from opencode-terminal-progress
// (MIT, pedropombeiro/opencode-plugins).
// Status texts. English canonical values (working/waiting/idle) match
// the official Claude integration verbatim and hit iTerm2's default
// priority sorting. Set OPENCODE_ITERM_STATUS_LANG=zh for Chinese.
const TEXT_ZH = {
  working: "工作中",
  waiting: "等待确认",
  idle: "空闲",
  error: "出错",
}
const TEXT_EN = {
  working: "working",
  waiting: "waiting",
  idle: "idle",
  error: "error",
}
const LANG_FORCE = (process.env["OPENCODE_ITERM_STATUS_LANG"] ?? "").toLowerCase()

// Language from macOS system language only (same source as iTerm2's
// UI language). Override with OPENCODE_ITERM_STATUS_LANG=zh|en.
function systemIsZh(): boolean {
  try {
    const out = execFileSync("defaults", ["read", "-g", "AppleLanguages"], {
      timeout: 2000,
      encoding: "utf8",
    }) as unknown as string
    const m = String(out).match(/"([A-Za-z-]+)"/)
    return m ? m[1].toLowerCase().startsWith("zh") : false
  } catch {
    return false
  }
}

const TEXT = LANG_FORCE.startsWith("zh")
  ? TEXT_ZH
  : LANG_FORCE.startsWith("en")
    ? TEXT_EN
    : systemIsZh()
      ? TEXT_ZH
      : TEXT_EN

const COLOR = {
  workingDot: "#34c759",
  workingText: "#ff9500",
  waitingDot: "#ff9f0a",
  waitingText: "#ff9f0a",
  idleDot: "#8e8e93",
  idleText: "#8e8e93",
  errorDot: "#ff453a",
  errorText: "#ff453a",
}

// Recompute the painted state this often so tab switches and missed
// events self-heal. Painting is suppressed unless the state changed.
const RECONCILE_MS = 5_000

const DEBUG = /^(1|true|yes)$/i.test(process.env["OPENCODE_ITERM_STATUS_DEBUG"] ?? "")
let activeCleanup: (() => void) | undefined
let debugFd: number | undefined
const debug = (msg: string) => {
  if (!DEBUG) return
  try {
    if (debugFd === undefined) {
      const tmp = (process.env["TMPDIR"] ?? "/tmp").replace(/\/$/, "")
      debugFd = openSync(`${tmp}/opencode-terminal-status-debug.log`, "a")
    }
    writeSync(debugFd, `${new Date().toISOString()} ${msg}\n`)
  } catch {
    // ignore
  }
}
const short = (sid: string | undefined) => (sid ? `..${sid.slice(-6)}` : "-")

function detectTerminal(env: Record<string, string | undefined>) {
  const program = env["TERM_PROGRAM"] ?? ""
  const isITerm = program === "iTerm.app" || env["LC_TERMINAL"] === "iTerm2" || !!env["ITERM_SESSION_ID"]
  const isKitty = program === "kitty" || !!env["KITTY_WINDOW_ID"]
  const supportsProgress =
    isITerm ||
    isKitty ||
    program === "ghostty" ||
    program === "WezTerm" ||
    !!env["WEZTERM_EXECUTABLE"] ||
    !!env["WT_SESSION"]
  if (!supportsProgress) return undefined
  return { progress: true, status: isITerm, kitty: isKitty }
}

function createOsc() {
  const inTmux = !!process.env["TMUX"]
  let fd: number
  try {
    fd = openSync("/dev/tty", "w")
  } catch {
    return undefined
  }
  return {
    write(payload: string) {
      const esc = inTmux ? `\x1BPtmux;\x1B\x1B]${payload}\x07\x1B\\` : `\x1B]${payload}\x07`
      try {
        writeSync(fd, esc)
      } catch {
        // tty gone, ignore
      }
    },
    close() {
      try {
        closeSync(fd)
      } catch {
        // ignore
      }
    },
  }
}

function waitingDetail(data: any): string {
  if (data?.action) {
    const resource = data?.resources?.[0]
    return resource ? `${data.action}: ${resource}` : String(data.action)
  }
  if (data?.form?.title) return String(data.form.title)
  if (data?.title) return String(data.title)
  return ""
}

function eventSessionID(event: any): string | undefined {
  const data = event?.data
  if (typeof data?.sessionID === "string") return data.sessionID
  const formSessionID = data?.form?.sessionID
  if (typeof formSessionID === "string") return formSessionID
  const infoID = data?.info?.id
  if (typeof infoID === "string" && typeof event?.type === "string" && event.type.startsWith("session.")) return infoID
  return undefined
}

export default Plugin.define({
  id: "opencode-terminal-status",
  async setup(context: any) {
    // Same-module re-setup (hot reload) must not leave two painters.
    if (activeCleanup) {
      try {
        activeCleanup()
      } catch {
        // ignore
      }
      activeCleanup = undefined
    }
    const kill = process.env["OPENCODE_ITERM_STATUS"]
    if (kill && /^(0|false|no)$/i.test(kill)) return

    const term = detectTerminal(process.env as Record<string, string | undefined>)
    if (!term) return
    const osc = createOsc()
    if (!osc) return
    debug(`setup progress=${term.progress} status=${term.status} kitty=${term.kitty}`)

    const progress = (code: string) => {
      if (term.progress) osc.write(`9;4;${code}`)
    }
    const status = (text: string, dot: string, textColor: string, detail = "") => {
      if (!term.status) return
      osc.write(`21337;status=${text};indicator=${dot};status-color=${textColor};detail=${detail}`)
    }
    const clearStatus = () => {
      if (!term.status) return
      osc.write(`21337;status=;indicator=;status-color=;detail=`)
    }

    let kittyTimer: ReturnType<typeof setInterval> | undefined
    const clearKittyTimer = () => {
      if (kittyTimer) {
        clearInterval(kittyTimer)
        kittyTimer = undefined
      }
    }
    const sendProgress = (code: string) => {
      clearKittyTimer()
      progress(code)
      if (term.kitty) kittyTimer = setInterval(() => progress(code), 30_000)
    }

    const onBusy = () => {
      sendProgress("3")
      status(TEXT.working, COLOR.workingDot, COLOR.workingText)
    }
    const onWaiting = (detail = "") => {
      sendProgress("4;50")
      status(TEXT.waiting, COLOR.waitingDot, COLOR.waitingText, detail)
    }
    const onIdle = () => {
      clearKittyTimer()
      progress("0")
      status(TEXT.idle, COLOR.idleDot, COLOR.idleText)
    }
    const onError = () => {
      sendProgress("2")
      status(TEXT.error, COLOR.errorDot, COLOR.errorText)
    }

    // Global per-session tracking; the painted tab state derives from
    // the visible family only (see repaint).
    const states = new Map<string, string>()
    const waits = new Map<string, { sessionID: string; detail: string }>()
    const outcomes = new Map<string, "idle" | "error">()
    const parentCache = new Map<string, string | null>()
    const rootCache = new Map<string, string>()
    let lastPainted = ""

    const knownRoot = (sid: string): string | undefined => {
      try {
        if (!context.data.session.get(sid)) return undefined
        return context.data.session.root(sid) ?? sid
      } catch {
        return undefined
      }
    }

    const fetchParent = async (sid: string): Promise<{ ok: boolean; parent: string | null }> => {
      if (parentCache.has(sid)) return { ok: true, parent: parentCache.get(sid)! }
      try {
        const res: any = await context.client.session.get({ sessionID: sid })
        const p: string | null = res?.data?.parentID ?? res?.data?.info?.parentID ?? null
        if (!p) debug(`parent-miss ${short(sid)} keys=${Object.keys(res?.data ?? {}).join(",")}`)
        parentCache.set(sid, p)
        return { ok: true, parent: p }
      } catch {
        return { ok: false, parent: null }
      }
    }

    const familyRoot = async (sid: string): Promise<string> => {
      const hit = rootCache.get(sid)
      if (hit) return hit
      let cur = sid
      let uncertain = false
      const seen = new Set<string>()
      for (let i = 0; i < 12 && !seen.has(cur); i++) {
        seen.add(cur)
        // Prefer an explicit parentID link over root(): root() may not
        // walk parents for sessions the store barely knows.
        let linked: string | undefined
        try {
          const sess = context.data.session.get(cur)
          if (sess?.parentID && sess.parentID !== cur) linked = sess.parentID
        } catch {
          // ignore
        }
        if (linked) {
          cur = linked
          continue
        }
        const k = knownRoot(cur)
        if (k) {
          cur = k
          break
        }
        const { ok, parent } = await fetchParent(cur)
        if (!ok) uncertain = true
        if (!parent) break
        cur = parent
      }
      if (!uncertain) rootCache.set(sid, cur)
      else if (cur !== sid) rootCache.set(sid, cur)
      // Never cache a self-root: the parent may be assigned after
      // creation, so re-resolve it next time.
      if (cur === sid) rootCache.delete(sid)
      debug(`root ${short(sid)} -> ${short(cur)}${uncertain ? " uncertain" : ""}`)
      return cur
    }

    const repaint = async () => {
      try {
        const route = context.ui.router.current()
        const routeRoot = route?.type === "session" ? await familyRoot(route.sessionID) : undefined
        const tabRoots = new Set<string>()
        try {
          if (context.ui.tabs.enabled()) {
            for (const tab of context.ui.tabs.list() ?? []) {
              if (tab?.sessionID) tabRoots.add(await familyRoot(tab.sessionID))
            }
          }
        } catch {
          // ignore
        }
        const inScope = (r: string) => (routeRoot ? r === routeRoot : false) || tabRoots.has(r)
        const sids = new Set<string>([...states.keys()])
        waits.forEach((w) => sids.add(w.sessionID))
        const sidRoot = new Map<string, string>()
        const scopeRoots = new Set<string>()
        for (const sid of sids) {
          const r = await familyRoot(sid)
          sidRoot.set(sid, r)
          if (inScope(r)) scopeRoots.add(r)
        }
        const waiting = [...waits.values()].filter((w) => scopeRoots.has(sidRoot.get(w.sessionID)!))
        const busy = [...states.entries()].some(([sid, st]) => st === "busy" && scopeRoots.has(sidRoot.get(sid)!))
        let key: string | undefined
        let paint: (() => void) | undefined
        if (waiting.length > 0) {
          const detail = waiting[waiting.length - 1].detail
          key = `waiting|${detail}`
          paint = () => onWaiting(detail)
        } else if (busy) {
          key = "busy"
          paint = onBusy
        } else {
          const outs = [...scopeRoots].map((r) => outcomes.get(r)).filter((o) => o !== undefined)
          if (outs.includes("error")) {
            key = "done:error"
            paint = onError
          } else if (outs.includes("idle")) {
            key = "done:idle"
            paint = onIdle
          } else if (routeRoot && scopeRoots.size === 0) {
            key = "idle"
            paint = onIdle
          } else {
            return // home route with nothing in scope: leave the tab alone
          }
        }
        if (key === lastPainted) return
        lastPainted = key
        debug(`paint ${key} scope=[${[...scopeRoots].map(short).join(",")}]`)
        paint!()
      } catch {
        // store not ready, reconciler retries
      }
    }
    const queueRepaint = () => {
      void repaint()
    }

    const setState = (sid: string, state: string) => {
      if (state === "busy" && [...waits.values()].some((w) => w.sessionID === sid)) {
        queueRepaint()
        return
      }
      states.set(sid, state)
      if (state === "busy") void familyRoot(sid).then((r) => outcomes.delete(r))
      queueRepaint()
    }
    const clearWaits = (sid: string) => {
      waits.forEach((w, id) => {
        if (w.sessionID === sid) waits.delete(id)
      })
    }
    const finish = (sid: string, state: "idle" | "error") => {
      clearWaits(sid)
      if (states.has(sid)) {
        states.delete(sid)
        void familyRoot(sid).then((r) => {
          outcomes.set(r, state)
          queueRepaint()
        })
      }
      queueRepaint()
    }
    const wait = (sid: string, id: string, detail: string) => {
      waits.set(id, { sessionID: sid, detail })
      states.set(sid, "waiting")
      queueRepaint()
    }
    const resolve = (sid: string, id: string) => {
      if (waits.get(id)?.sessionID !== sid) return
      waits.delete(id)
      if (![...waits.values()].some((w) => w.sessionID === sid) && states.has(sid)) states.set(sid, "busy")
      queueRepaint()
    }
    const drop = (sid: string) => {
      states.delete(sid)
      clearWaits(sid)
      queueRepaint()
    }

    const handle = (event: any) => {
      switch (event?.type) {
        case "session.created":
        case "session.updated": {
          // Fresh info may carry a parent link: drop cached lookups.
          const sid: string | undefined = event?.data?.info?.id ?? event?.data?.sessionID
          if (typeof sid === "string") {
            parentCache.delete(sid)
            rootCache.delete(sid)
          }
          queueRepaint()
          return
        }
        case "session.status": {
          const { sessionID, status: st } = event.data
          if (st?.type === "busy") setState(sessionID, "busy")
          if (st?.type === "idle") finish(sessionID, "idle")
          else queueRepaint()
          return
        }
        case "session.execution.started":
          setState(event.data.sessionID, "busy")
          return
        case "session.idle":
        case "session.execution.succeeded":
        case "session.execution.interrupted":
          if (states.has(event.data.sessionID)) finish(event.data.sessionID, "idle")
          else queueRepaint()
          return
        case "session.execution.failed":
          if (states.has(event.data.sessionID)) finish(event.data.sessionID, "error")
          else queueRepaint()
          return
        case "session.deleted": {
          const sid = event.data?.info?.id ?? event.data?.sessionID
          if (typeof sid === "string") drop(sid)
          return
        }
        case "permission.asked":
          wait(event.data.sessionID, event.data.id, waitingDetail(event.data))
          return
        case "form.created":
          wait(event.data.form.sessionID, event.data.form.id, waitingDetail(event.data))
          return
        case "permission.replied":
          resolve(event.data.sessionID, event.data.requestID)
          return
        case "form.replied":
        case "form.cancelled":
          resolve(event.data.sessionID, event.data.id)
          return
      }
    }

    const stop = context.data.listen((ev: any) => {
      const details = ev?.details ?? ev
      const t = details?.type
      const sid = eventSessionID(details)
      if (DEBUG && typeof t === "string" && /^(session|permission|form|question)\./.test(t)) {
        debug(`event ${t} sid=${short(sid)}`)
      }
      if (sid === undefined) return
      handle(details)
    })

    // Seed from live sessions (covers TUI restarts mid-work), then heal
    // periodically for tab switches and missed events.
    try {
      const now = Date.now()
      for (const s of context.data.session.list() ?? []) {
        const sid = typeof s === "string" ? s : s?.id
        if (!sid || states.has(sid)) continue
        const updated = typeof s !== "string" ? (s?.time?.updated ?? s?.timeUpdated ?? 0) : 0
        if (updated && now - updated > 15 * 60_000) continue
        let st: string | undefined
        try {
          st = context.data.session.status(sid)
        } catch {
          st = undefined
        }
        if (st === "working" || st === "compacting") states.set(sid, "busy")
      }
    } catch {
      // ignore
    }
    queueRepaint()
    const reconciler = setInterval(queueRepaint, RECONCILE_MS)

    const cleanup = () => {
      stop()
      clearInterval(reconciler)
      clearKittyTimer()
      progress("0")
      clearStatus()
      osc.close()
      try {
        if (debugFd !== undefined) closeSync(debugFd)
      } catch {
        // ignore
      }
      debugFd = undefined
      if (activeCleanup === cleanup) activeCleanup = undefined
    }
    activeCleanup = cleanup
    return cleanup
  },
})
