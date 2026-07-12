// Shared workout-overlay state + actions + timer engine.
// One source of truth synced across windows AND across separate apps
// (Control page, OBS overlay, phone remote) that do NOT share local storage.
//
// Transports, priority order (all best-effort, guarded):
//   1. WebSocket relay (relay.js) — instant, offline, private. Preferred.
//      Same machine: ws://127.0.0.1:8787.  Phone on Wi-Fi / page served by the
//      relay: derived from the page URL automatically.
//   2. ntfy.sh pub/sub over HTTPS — automatic fallback when no relay.
//   3. localStorage + BroadcastChannel — same-browser tabs.
//   4. in-memory listeners — same document.
//
// The always-on OVERLAY owns clock advancement (work->rest->rounds->next block)
// so it keeps running no matter which controllers are open, and controllers/
// remotes never fight over it. Set window.WORKOUT_ROLE = 'overlay' | 'control'
// | 'remote' before loading this file.
//
// Guarded IIFE: safe to include more than once and when bundled into one file.

(function () {
  if (window.WorkoutStore) return;

  const KEY = 'wko:state:v3';
  const CH = 'wko:channel:v3';
  const PHASES = ['FLOW', 'CONTROL', 'LOAD', 'SUSTAINED EFFORT'];
  const ROLE = window.WORKOUT_ROLE || 'control';

  function defaultState() {
    return {
      seq: 0,
      className: 'IAN · EXOS',
      plan: [
        { phase: 'FLOW', exercise: 'Dynamic mobility', work: 60, rest: 0, rounds: 1 },
        { phase: 'CONTROL', exercise: 'Tempo goblet squats', work: 45, rest: 15, rounds: 5 },
        { phase: 'LOAD', exercise: 'Heavy farmer carries', work: 40, rest: 20, rounds: 4 },
        { phase: 'SUSTAINED EFFORT', exercise: 'AMRAP circuit', work: 180, rest: 60, rounds: 3 },
        { phase: 'FLOW', exercise: 'Cooldown & breath', work: 120, rest: 0, rounds: 1 },
      ],
      stepIndex: 1,
      autoAdvance: false,
      phase: 'CONTROL',
      exercise: 'Tempo goblet squats',
      nextUp: 'Heavy farmer carries',
      round: { current: 1, total: 5 },
      showOverview: true,
      modules: { label: true, phase: true, round: true, exercise: true, timer: true, overview: true },
      timer: {
        running: false, mode: 'WORK',
        duration: 45, remaining: 45, endsAt: 0,
        workDur: 45, restDur: 15,
      },
    };
  }

  function isObj(x) { return x && typeof x === 'object' && !Array.isArray(x); }
  function merge(a, b) {
    if (!isObj(a) || !isObj(b)) return b;
    const o = { ...a };
    for (const k in b) o[k] = isObj(a[k]) && isObj(b[k]) ? merge(a[k], b[k]) : b[k];
    return o;
  }

  const listeners = new Set();
  const bc = ('BroadcastChannel' in window) ? new BroadcastChannel(CH) : null;
  function bcPost(obj) { if (bc) { try { bc.postMessage({ ...obj, role: ROLE, from: SELF }); } catch (e) {} } }

  function load() {
    try { const raw = localStorage.getItem(KEY); if (raw) return merge(defaultState(), JSON.parse(raw)); } catch (e) {}
    return defaultState();
  }
  let state = load();
  let overlaySeenAt = 0;

  function persist() { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) {} }
  function notify() { listeners.forEach(fn => { try { fn(state); } catch (e) {} }); }

  function applyRemote(msg) {
    if (!msg || msg.from === SELF) return;
    if (msg.role === 'overlay') overlaySeenAt = Date.now();
    if (msg.t === 'hello') { pushState(); return; }
    if (msg.t === 'state' && msg.state && (msg.state.seq || 0) > (state.seq || 0)) {
      state = msg.state; persist(); notify();
    }
  }

  // ---------- transports ----------
  const params = new URLSearchParams(location.search);
  const TOPIC = (params.get('sync') || 'wko-ianexos-7Qk2Zt').replace(/[^a-zA-Z0-9_-]/g, '') || 'wko-ianexos-7Qk2Zt';
  const BASE = 'https://ntfy.sh/' + TOPIC;
  const SELF = Math.random().toString(36).slice(2);

  let WS_URL = params.get('relay');
  if (!WS_URL) {
    if (location.protocol === 'http:' || location.protocol === 'https:') {
      const proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
      const port = location.port || (location.protocol === 'https:' ? '443' : '80');
      WS_URL = proto + location.hostname + ':' + port; // page served by the relay -> same host
    } else {
      WS_URL = 'ws://127.0.0.1:8787'; // opened as a local file
    }
  }

  let ws = null, wsOpen = false, es = null, esOpen = false;

  function setNetMode() {
    const mode = wsOpen ? 'local' : (esOpen ? 'cloud' : 'off');
    if (store.netMode !== mode) { store.netMode = mode; store.netConnected = mode !== 'off'; notify(); }
  }
  function publish(obj) {
    obj.role = ROLE; obj.from = SELF;
    const body = JSON.stringify(obj);
    if (wsOpen && ws) { try { ws.send(body); return; } catch (e) {} }
    try { fetch(BASE, { method: 'POST', body, keepalive: true }); } catch (e) {}
  }
  function pushState() { publish({ t: 'state', state }); }

  function connectWS() {
    try {
      ws = new WebSocket(WS_URL);
      ws.onopen = () => { wsOpen = true; setNetMode(); closeCloud(); publish({ t: 'hello' }); };
      ws.onmessage = (ev) => { try { applyRemote(JSON.parse(ev.data)); } catch (e) {} };
      ws.onclose = () => { wsOpen = false; setNetMode(); ensureCloud(); setTimeout(connectWS, 2500); };
      ws.onerror = () => { try { ws.close(); } catch (e) {} };
    } catch (e) { ensureCloud(); setTimeout(connectWS, 2500); }
  }
  function ensureCloud() { if (!es) connectCloud(); }
  function closeCloud() { if (es) { try { es.close(); } catch (e) {} es = null; esOpen = false; setNetMode(); } }
  function connectCloud() {
    try {
      es = new EventSource(BASE + '/sse');
      es.onopen = () => { esOpen = true; setNetMode(); };
      es.onmessage = (ev) => {
        let d; try { d = JSON.parse(ev.data); } catch (e) { return; }
        if (d.event === 'open') { esOpen = true; setNetMode(); return; }
        if (d.event !== 'message' || !d.message) return;
        try { applyRemote(JSON.parse(d.message)); } catch (e) {}
      };
      es.onerror = () => { esOpen = false; setNetMode(); };
    } catch (e) {}
  }

  // ---------- timer engine ----------
  function remaining() {
    const t = state.timer;
    return t.running ? Math.max(0, (t.endsAt - Date.now()) / 1000) : Math.max(0, t.remaining);
  }
  function doAdvance() {
    const t = state.timer;
    if (t.mode === 'WORK' && t.restDur > 0) {
      store.set({ timer: { mode: 'REST', duration: t.restDur, remaining: t.restDur, endsAt: Date.now() + t.restDur * 1000, running: true } });
    } else if (state.round.current < state.round.total) {
      store.set({ round: { current: state.round.current + 1 }, timer: { mode: 'WORK', duration: t.workDur, remaining: t.workDur, endsAt: Date.now() + t.workDur * 1000, running: true } });
    } else if (state.autoAdvance && state.stepIndex < state.plan.length - 1) {
      store.loadStep(state.stepIndex + 1, true);
    } else {
      store.set({ timer: { running: false, endsAt: 0 } });
    }
  }

  const store = {
    PHASES, topic: TOPIC, role: ROLE, netMode: 'off', netConnected: false,
    get() { return state; },
    remaining,
    set(patch, opts) {
      const p = typeof patch === 'function' ? patch(state) : patch;
      const seq = (state.seq || 0) + 1;
      state = merge(state, p); state.seq = seq;
      persist(); notify();
      if (!(opts && opts.silent)) bcPost({ type: 'state', state });
      pushState();
    },
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },

    // --- who advances the clock ---
    isAdvancer() {
      if (ROLE === 'remote') return false;
      if (ROLE === 'overlay') return true;
      return (Date.now() - overlaySeenAt) > 6000; // control advances only if no overlay present
    },
    tickAdvance() {
      if (!this.isAdvancer()) return false;
      const t = state.timer;
      if (t.running && (t.endsAt - Date.now()) <= 0) { doAdvance(); return true; }
      return false;
    },

    // --- plan navigation (commands) ---
    loadStep(i, start) {
      const plan = state.plan; if (i < 0 || i >= plan.length) return;
      const st = plan[i];
      this.set({
        stepIndex: i, phase: st.phase, exercise: st.exercise,
        nextUp: plan[i + 1] ? plan[i + 1].exercise : 'Finish',
        round: { current: 1, total: Math.max(1, st.rounds || 1) },
        timer: { mode: 'WORK', workDur: st.work, restDur: st.rest, duration: st.work, remaining: st.work, running: !!start, endsAt: start ? Date.now() + st.work * 1000 : 0 },
      });
    },
    nextStep() { this.loadStep(state.stepIndex + 1, true); },
    prevStep() { this.loadStep(state.stepIndex - 1, true); },
    skip() { doAdvance(); },

    // --- transport (commands) ---
    startPause() {
      const t = state.timer;
      if (t.running) this.set({ timer: { running: false, remaining: Math.max(0, (t.endsAt - Date.now()) / 1000), endsAt: 0 } });
      else { const rem = t.remaining > 0 ? t.remaining : t.duration; this.set({ timer: { running: true, remaining: rem, endsAt: Date.now() + rem * 1000 } }); }
    },
    resetTimer() {
      const t = state.timer; const dur = t.mode === 'WORK' ? t.workDur : t.restDur;
      this.set({ timer: { running: false, duration: dur, remaining: dur, endsAt: 0 } });
    },
    adjust(delta) {
      const t = state.timer; const rem = Math.max(0, remaining() + delta);
      this.set({ timer: { remaining: rem, duration: Math.max(t.duration, rem), endsAt: t.running ? Date.now() + rem * 1000 : 0 } });
    },
    setTimerMode(mode) {
      const t = state.timer; const dur = mode === 'WORK' ? t.workDur : t.restDur;
      this.set({ timer: { mode, duration: dur, remaining: dur, running: false, endsAt: 0 } });
    },
    changeDur(kind, delta) {
      const t = state.timer; const key = kind === 'WORK' ? 'workDur' : 'restDur';
      const val = Math.max(kind === 'REST' ? 0 : 5, t[key] + delta);
      const patch = { timer: {} }; patch.timer[key] = val;
      if (t.mode === kind && !t.running) { patch.timer.duration = val; patch.timer.remaining = val; }
      this.set(patch);
    },

    // --- plan editing (build) ---
    planNum(i, key, delta) {
      const plan = state.plan.slice(); let v = (plan[i][key] || 0) + delta;
      if (key === 'work') v = Math.max(5, v); else if (key === 'rest') v = Math.max(0, v); else if (key === 'rounds') v = Math.max(1, v);
      plan[i] = { ...plan[i], [key]: v }; this.set({ plan });
    },
    planText(i, value) { const plan = state.plan.slice(); if (plan[i]) { plan[i] = { ...plan[i], exercise: value }; this.set({ plan }); } },
    planPhase(i) { const plan = state.plan.slice(); const idx = (PHASES.indexOf(plan[i].phase) + 1) % PHASES.length; plan[i] = { ...plan[i], phase: PHASES[idx] }; this.set({ plan }); },
    planMove(i, dir) {
      const plan = state.plan.slice(); const j = i + dir; if (j < 0 || j >= plan.length) return;
      const tmp = plan[i]; plan[i] = plan[j]; plan[j] = tmp;
      let si = state.stepIndex; if (si === i) si = j; else if (si === j) si = i;
      this.set({ plan, stepIndex: si });
    },
    planRemove(i) {
      const plan = state.plan.slice(); plan.splice(i, 1);
      let si = state.stepIndex; if (i < si) si--; si = Math.max(0, Math.min(si, plan.length - 1));
      this.set({ plan, stepIndex: si });
    },
    planAdd() { const plan = state.plan.slice(); plan.push({ phase: 'FLOW', exercise: 'New exercise', work: 45, rest: 15, rounds: 3 }); this.set({ plan }); },

    reset() {
      const seq = (state.seq || 0) + 1; state = defaultState(); state.seq = seq;
      persist(); notify(); bcPost({ type: 'state', state }); pushState();
    },
  };

  if (bc) bc.onmessage = (e) => {
    const d = e.data; if (!d || d.from === SELF) return;
    if (d.role === 'overlay') overlaySeenAt = Date.now();
    if (d.type === 'state' && (d.state.seq || 0) > (state.seq || 0)) { state = d.state; persist(); notify(); }
  };
  window.addEventListener('storage', (e) => {
    if (e.key === KEY && e.newValue) { try { const ns = JSON.parse(e.newValue); if ((ns.seq || 0) > (state.seq || 0)) { state = ns; notify(); } } catch (err) {} }
  });

  connectWS();
  setTimeout(() => { if (!wsOpen) { ensureCloud(); publish({ t: 'hello' }); } }, 1500);
  setInterval(pushState, 5000);
  setInterval(() => bcPost({ type: 'ping' }), 3000); // same-browser presence heartbeat

  window.WorkoutStore = store;
})();
