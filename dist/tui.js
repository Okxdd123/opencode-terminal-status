// src/tui.ts
import { Plugin } from "@opencode/plugin/tui";
import { execFileSync } from "child_process";
var {closeSync, openSync, writeSync} = (() => ({}));
var TEXT_ZH = {
  working: "工作中",
  waiting: "等待确认",
  idle: "空闲",
  error: "出错"
};
var TEXT_EN = {
  working: "working",
  waiting: "waiting",
  idle: "idle",
  error: "error"
};
var LANG_FORCE = (process.env["OPENCODE_ITERM_STATUS_LANG"] ?? "").toLowerCase();
function systemIsZh() {
  try {
    const out = execFileSync("defaults", ["read", "-g", "AppleLanguages"], {
      timeout: 2000,
      encoding: "utf8"
    });
    const m = String(out).match(/"([A-Za-z-]+)"/);
    return m ? m[1].toLowerCase().startsWith("zh") : false;
  } catch {
    return false;
  }
}
var TEXT = LANG_FORCE.startsWith("zh") ? TEXT_ZH : LANG_FORCE.startsWith("en") ? TEXT_EN : systemIsZh() ? TEXT_ZH : TEXT_EN;
var COLOR = {
  workingDot: "#34c759",
  workingText: "#ff9500",
  waitingDot: "#ff9f0a",
  waitingText: "#ff9f0a",
  idleDot: "#8e8e93",
  idleText: "#8e8e93",
  errorDot: "#ff453a",
  errorText: "#ff453a"
};
var RECONCILE_MS = 5000;
var DEBUG = /^(1|true|yes)$/i.test(process.env["OPENCODE_ITERM_STATUS_DEBUG"] ?? "");
var activeCleanup;
var debugFd;
var debug = (msg) => {
  if (!DEBUG)
    return;
  try {
    if (debugFd === undefined) {
      const tmp = (process.env["TMPDIR"] ?? "/tmp").replace(/\/$/, "");
      debugFd = openSync(`${tmp}/opencode-terminal-status-debug.log`, "a");
    }
    writeSync(debugFd, `${new Date().toISOString()} ${msg}
`);
  } catch {}
};
var short = (sid) => sid ? `..${sid.slice(-6)}` : "-";
function detectTerminal(env) {
  const program = env["TERM_PROGRAM"] ?? "";
  const isITerm = program === "iTerm.app" || env["LC_TERMINAL"] === "iTerm2" || !!env["ITERM_SESSION_ID"];
  const isKitty = program === "kitty" || !!env["KITTY_WINDOW_ID"];
  const supportsProgress = isITerm || isKitty || program === "ghostty" || program === "WezTerm" || !!env["WEZTERM_EXECUTABLE"] || !!env["WT_SESSION"];
  if (!supportsProgress)
    return;
  return { progress: true, status: isITerm, kitty: isKitty };
}
function createOsc() {
  const inTmux = !!process.env["TMUX"];
  let fd;
  try {
    fd = openSync("/dev/tty", "w");
  } catch {
    return;
  }
  return {
    write(payload) {
      const esc = inTmux ? `\x1BPtmux;\x1B\x1B]${payload}\x07\x1B\\` : `\x1B]${payload}\x07`;
      try {
        writeSync(fd, esc);
      } catch {}
    },
    close() {
      try {
        closeSync(fd);
      } catch {}
    }
  };
}
function waitingDetail(data) {
  if (data?.action) {
    const resource = data?.resources?.[0];
    return resource ? `${data.action}: ${resource}` : String(data.action);
  }
  if (data?.form?.title)
    return String(data.form.title);
  if (data?.title)
    return String(data.title);
  return "";
}
function eventSessionID(event) {
  const data = event?.data;
  if (typeof data?.sessionID === "string")
    return data.sessionID;
  const formSessionID = data?.form?.sessionID;
  if (typeof formSessionID === "string")
    return formSessionID;
  const infoID = data?.info?.id;
  if (typeof infoID === "string" && typeof event?.type === "string" && event.type.startsWith("session."))
    return infoID;
  return;
}
var tui_default = Plugin.define({
  id: "opencode-terminal-status",
  async setup(context) {
    if (activeCleanup) {
      try {
        activeCleanup();
      } catch {}
      activeCleanup = undefined;
    }
    const kill = process.env["OPENCODE_ITERM_STATUS"];
    if (kill && /^(0|false|no)$/i.test(kill))
      return;
    const term = detectTerminal(process.env);
    if (!term)
      return;
    const osc = createOsc();
    if (!osc)
      return;
    debug(`setup progress=${term.progress} status=${term.status} kitty=${term.kitty}`);
    const progress = (code) => {
      if (term.progress)
        osc.write(`9;4;${code}`);
    };
    const status = (text, dot, textColor, detail = "") => {
      if (!term.status)
        return;
      osc.write(`21337;status=${text};indicator=${dot};status-color=${textColor};detail=${detail}`);
    };
    const clearStatus = () => {
      if (!term.status)
        return;
      osc.write(`21337;status=;indicator=;status-color=;detail=`);
    };
    let kittyTimer;
    const clearKittyTimer = () => {
      if (kittyTimer) {
        clearInterval(kittyTimer);
        kittyTimer = undefined;
      }
    };
    const sendProgress = (code) => {
      clearKittyTimer();
      progress(code);
      if (term.kitty)
        kittyTimer = setInterval(() => progress(code), 30000);
    };
    const onBusy = () => {
      sendProgress("3");
      status(TEXT.working, COLOR.workingDot, COLOR.workingText);
    };
    const onWaiting = (detail = "") => {
      sendProgress("4;50");
      status(TEXT.waiting, COLOR.waitingDot, COLOR.waitingText, detail);
    };
    const onIdle = () => {
      clearKittyTimer();
      progress("0");
      status(TEXT.idle, COLOR.idleDot, COLOR.idleText);
    };
    const onError = () => {
      sendProgress("2");
      status(TEXT.error, COLOR.errorDot, COLOR.errorText);
    };
    const states = new Map;
    const waits = new Map;
    const outcomes = new Map;
    const parentCache = new Map;
    const rootCache = new Map;
    let lastPainted = "";
    const knownRoot = (sid) => {
      try {
        if (!context.data.session.get(sid))
          return;
        return context.data.session.root(sid) ?? sid;
      } catch {
        return;
      }
    };
    const fetchParent = async (sid) => {
      if (parentCache.has(sid))
        return { ok: true, parent: parentCache.get(sid) };
      try {
        const res = await context.client.session.get({ sessionID: sid });
        const p = res?.data?.parentID ?? res?.data?.info?.parentID ?? null;
        if (!p)
          debug(`parent-miss ${short(sid)} keys=${Object.keys(res?.data ?? {}).join(",")}`);
        parentCache.set(sid, p);
        return { ok: true, parent: p };
      } catch {
        return { ok: false, parent: null };
      }
    };
    const familyRoot = async (sid) => {
      const hit = rootCache.get(sid);
      if (hit)
        return hit;
      let cur = sid;
      let uncertain = false;
      const seen = new Set;
      for (let i = 0;i < 12 && !seen.has(cur); i++) {
        seen.add(cur);
        let linked;
        try {
          const sess = context.data.session.get(cur);
          if (sess?.parentID && sess.parentID !== cur)
            linked = sess.parentID;
        } catch {}
        if (linked) {
          cur = linked;
          continue;
        }
        const k = knownRoot(cur);
        if (k) {
          cur = k;
          break;
        }
        const { ok, parent } = await fetchParent(cur);
        if (!ok)
          uncertain = true;
        if (!parent)
          break;
        cur = parent;
      }
      if (!uncertain)
        rootCache.set(sid, cur);
      else if (cur !== sid)
        rootCache.set(sid, cur);
      if (cur === sid)
        rootCache.delete(sid);
      debug(`root ${short(sid)} -> ${short(cur)}${uncertain ? " uncertain" : ""}`);
      return cur;
    };
    const repaint = async () => {
      try {
        const route = context.ui.router.current();
        const routeRoot = route?.type === "session" ? await familyRoot(route.sessionID) : undefined;
        const tabRoots = new Set;
        try {
          if (context.ui.tabs.enabled()) {
            for (const tab of context.ui.tabs.list() ?? []) {
              if (tab?.sessionID)
                tabRoots.add(await familyRoot(tab.sessionID));
            }
          }
        } catch {}
        const inScope = (r) => (routeRoot ? r === routeRoot : false) || tabRoots.has(r);
        const sids = new Set([...states.keys()]);
        waits.forEach((w) => sids.add(w.sessionID));
        const sidRoot = new Map;
        const scopeRoots = new Set;
        for (const sid of sids) {
          const r = await familyRoot(sid);
          sidRoot.set(sid, r);
          if (inScope(r))
            scopeRoots.add(r);
        }
        const waiting = [...waits.values()].filter((w) => scopeRoots.has(sidRoot.get(w.sessionID)));
        const busy = [...states.entries()].some(([sid, st]) => st === "busy" && scopeRoots.has(sidRoot.get(sid)));
        let key;
        let paint;
        if (waiting.length > 0) {
          const detail = waiting[waiting.length - 1].detail;
          key = `waiting|${detail}`;
          paint = () => onWaiting(detail);
        } else if (busy) {
          key = "busy";
          paint = onBusy;
        } else {
          const outs = [...scopeRoots].map((r) => outcomes.get(r)).filter((o) => o !== undefined);
          if (outs.includes("error")) {
            key = "done:error";
            paint = onError;
          } else if (outs.includes("idle")) {
            key = "done:idle";
            paint = onIdle;
          } else if (routeRoot && scopeRoots.size === 0) {
            key = "idle";
            paint = onIdle;
          } else {
            return;
          }
        }
        if (key === lastPainted)
          return;
        lastPainted = key;
        debug(`paint ${key} scope=[${[...scopeRoots].map(short).join(",")}]`);
        paint();
      } catch {}
    };
    const queueRepaint = () => {
      repaint();
    };
    const setState = (sid, state) => {
      if (state === "busy" && [...waits.values()].some((w) => w.sessionID === sid)) {
        queueRepaint();
        return;
      }
      states.set(sid, state);
      if (state === "busy")
        familyRoot(sid).then((r) => outcomes.delete(r));
      queueRepaint();
    };
    const clearWaits = (sid) => {
      waits.forEach((w, id) => {
        if (w.sessionID === sid)
          waits.delete(id);
      });
    };
    const finish = (sid, state) => {
      clearWaits(sid);
      if (states.has(sid)) {
        states.delete(sid);
        familyRoot(sid).then((r) => {
          outcomes.set(r, state);
          queueRepaint();
        });
      }
      queueRepaint();
    };
    const wait = (sid, id, detail) => {
      waits.set(id, { sessionID: sid, detail });
      states.set(sid, "waiting");
      queueRepaint();
    };
    const resolve = (sid, id) => {
      if (waits.get(id)?.sessionID !== sid)
        return;
      waits.delete(id);
      if (![...waits.values()].some((w) => w.sessionID === sid) && states.has(sid))
        states.set(sid, "busy");
      queueRepaint();
    };
    const drop = (sid) => {
      states.delete(sid);
      clearWaits(sid);
      queueRepaint();
    };
    const handle = (event) => {
      switch (event?.type) {
        case "session.created":
        case "session.updated": {
          const sid = event?.data?.info?.id ?? event?.data?.sessionID;
          if (typeof sid === "string") {
            parentCache.delete(sid);
            rootCache.delete(sid);
          }
          queueRepaint();
          return;
        }
        case "session.status": {
          const { sessionID, status: st } = event.data;
          if (st?.type === "busy")
            setState(sessionID, "busy");
          if (st?.type === "idle")
            finish(sessionID, "idle");
          else
            queueRepaint();
          return;
        }
        case "session.execution.started":
          setState(event.data.sessionID, "busy");
          return;
        case "session.idle":
        case "session.execution.succeeded":
        case "session.execution.interrupted":
          if (states.has(event.data.sessionID))
            finish(event.data.sessionID, "idle");
          else
            queueRepaint();
          return;
        case "session.execution.failed":
          if (states.has(event.data.sessionID))
            finish(event.data.sessionID, "error");
          else
            queueRepaint();
          return;
        case "session.deleted": {
          const sid = event.data?.info?.id ?? event.data?.sessionID;
          if (typeof sid === "string")
            drop(sid);
          return;
        }
        case "permission.asked":
          wait(event.data.sessionID, event.data.id, waitingDetail(event.data));
          return;
        case "form.created":
          wait(event.data.form.sessionID, event.data.form.id, waitingDetail(event.data));
          return;
        case "permission.replied":
          resolve(event.data.sessionID, event.data.requestID);
          return;
        case "form.replied":
        case "form.cancelled":
          resolve(event.data.sessionID, event.data.id);
          return;
      }
    };
    const stop = context.data.listen((ev) => {
      const details = ev?.details ?? ev;
      const t = details?.type;
      const sid = eventSessionID(details);
      if (DEBUG && typeof t === "string" && /^(session|permission|form|question)\./.test(t)) {
        debug(`event ${t} sid=${short(sid)}`);
      }
      if (sid === undefined)
        return;
      handle(details);
    });
    try {
      const now = Date.now();
      for (const s of context.data.session.list() ?? []) {
        const sid = typeof s === "string" ? s : s?.id;
        if (!sid || states.has(sid))
          continue;
        const updated = typeof s !== "string" ? s?.time?.updated ?? s?.timeUpdated ?? 0 : 0;
        if (updated && now - updated > 15 * 60000)
          continue;
        let st;
        try {
          st = context.data.session.status(sid);
        } catch {
          st = undefined;
        }
        if (st === "working" || st === "compacting")
          states.set(sid, "busy");
      }
    } catch {}
    queueRepaint();
    const reconciler = setInterval(queueRepaint, RECONCILE_MS);
    const cleanup = () => {
      stop();
      clearInterval(reconciler);
      clearKittyTimer();
      progress("0");
      clearStatus();
      osc.close();
      try {
        if (debugFd !== undefined)
          closeSync(debugFd);
      } catch {}
      debugFd = undefined;
      if (activeCleanup === cleanup)
        activeCleanup = undefined;
    };
    activeCleanup = cleanup;
    return cleanup;
  }
});
export {
  tui_default as default
};
