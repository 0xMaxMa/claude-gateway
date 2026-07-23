/**
 * Generates a self-contained HTML dashboard page for the gateway status UI.
 * No external dependencies except xterm.js CDN for PTY viewer.
 */
export function generateDashboardHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Claude Gateway</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@xterm/xterm@6.0.0/css/xterm.min.css"
    integrity="sha384-eDYu/eBZQNhtqTaA7Wl3XighXKxm/9VYF+Chh3hQS+UUlKQIJ14hK2imKu4n99aR" crossorigin="anonymous"/>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, monospace;
      background: #0f1117;
      color: #e2e8f0;
      padding: 24px;
    }
    h1 { font-size: 1.5rem; margin-bottom: 8px; }
    .rainbow {
      background: linear-gradient(90deg, #ff0080, #ff8c00, #ffe600, #00d26a, #00b4ff, #a855f7, #ff0080);
      background-size: 200% auto;
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
      animation: rainbow-shift 3s linear infinite;
    }
    @keyframes rainbow-shift { to { background-position: 200% center; } }
    .meta { color: #718096; font-size: 0.85rem; margin-bottom: 16px; }
    .meta span { color: #a0aec0; }
    h2 { color: #90cdf4; font-size: 1.1rem; margin: 20px 0 10px; }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 0.875rem;
      margin-bottom: 24px;
    }
    th {
      background: #1a202c;
      color: #718096;
      text-align: left;
      padding: 8px 12px;
      border-bottom: 1px solid #2d3748;
      font-weight: 600;
      text-transform: uppercase;
      font-size: 0.75rem;
      letter-spacing: 0.05em;
    }
    td {
      padding: 8px 12px;
      border-bottom: 1px solid #1a202c;
    }
    tr.session-row td { background: #0f1117; color: #cbd5e0; font-size: 0.82rem; }
    tr.session-row:hover td { background: #1a202c; }
    .badge {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 9999px;
      font-size: 0.75rem;
      font-weight: 600;
    }
    .badge-green { background: #22543d; color: #68d391; }
    .badge-red { background: #742a2a; color: #fc8181; }
    .badge-gray { background: #2d3748; color: #a0aec0; }
    .badge-blue { background: #1a365d; color: #63b3ed; }
    .badge-purple { background: #44337a; color: #b794f4; }
    /* Per-model badge colors — each model family gets a distinct hue. */
    .badge-opus { background: #5a3a1a; color: #f6ad55; }
    .badge-sonnet { background: #1a4a52; color: #4fd1c5; }
    .badge-haiku { background: #22543d; color: #68d391; }
    .badge-fable { background: #553052; color: #f687b3; }
    .badge-model { background: #2d3748; color: #cbd5e0; }
    .ts { color: #718096; font-size: 0.8rem; }
    #refresh-indicator { float: right; font-size: 0.75rem; color: #4a5568; }
    .error { color: #fc8181; font-size: 0.85rem; margin-top: 8px; }
    .btn-stream {
      background: #44337a;
      color: #d6bcfa;
      border: 1px solid #6b46c1;
      border-radius: 4px;
      padding: 2px 8px;
      font-size: 0.75rem;
      cursor: pointer;
    }
    .btn-stream:hover { background: #6b46c1; color: #faf5ff; }
    .pty-viewer {
      display: none;
      margin-top: 24px;
      border: 1px solid #2d3748;
      border-radius: 6px;
      overflow-x: hidden;
    }
    .pty-viewer-header {
      background: #1a202c;
      padding: 8px 12px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      font-size: 0.85rem;
      color: #a0aec0;
    }
    .pty-viewer-header .agent-label { color: #63b3ed; font-weight: 600; }
    .pty-viewer-header .session-label { color: #718096; font-family: monospace; font-size: 0.78rem; }
    .pty-close, .pty-refresh {
      background: none;
      border: none;
      color: #718096;
      cursor: pointer;
      font-size: 1rem;
      padding: 0 4px;
    }
    .pty-close:hover { color: #fc8181; }
    .pty-refresh:hover { color: #63b3ed; }
    /* Keyboard-focus outline on the viewer (it is tabindex focusable so PageUp/
       PageDown reach the terminal); keep it subtle rather than the default ring. */
    #pty-terminal:focus, #pty-terminal:focus-visible { outline: 1px solid #2d3748; }
    .pty-mode-toggle {
      background: none;
      border: 1px solid #2d3748;
      border-radius: 4px;
      color: #718096;
      cursor: pointer;
      font-size: 0.72rem;
      padding: 1px 7px;
      margin-right: 6px;
    }
    .pty-mode-toggle:hover { color: #63b3ed; border-color: #3d4a5f; }
    /* Active (input) mode — clearly signals the viewer now types into the PTY. */
    .pty-mode-toggle.input-active { color: #0d1117; background: #63b3ed; border-color: #63b3ed; font-weight: 600; }
    /* Fixed-size terminal viewport — the server PTY runs at 200x50, so the
       viewer must NOT resize to the panel (that mismatch is what garbles the
       output). We render at the native size and pan horizontally if the 200-col
       width overflows the panel. The Claude TUI uses the alternate screen buffer
       (\x1b[?1049h), which has no scrollback by design — so there is nothing to
       scroll vertically and we hide the (non-functional) vertical scrollbar. */
    #pty-terminal {
      padding: 8px;
      background: #0d1117;
      overflow-x: auto;
      overflow-y: hidden;
      border-radius: 6px;
    }
    /* No scrollback in alt-screen mode → suppress xterm's vertical scrollbar. */
    #pty-terminal .xterm-viewport { overflow-y: hidden !important; }
    .proc-tree {
      font-family: monospace;
      font-size: 0.82rem;
      background: #0d1117;
      border: 1px solid #2d3748;
      border-radius: 6px;
      padding: 12px 16px;
      white-space: pre-wrap;
      word-break: break-word;
      color: #a0aec0;
    }
    .proc-tree .proc-orchestrator { color: #63b3ed; }
    .proc-tree .proc-pty { color: #68d391; }
    .proc-tree .proc-claude { color: #f6e05e; }
    .proc-tree .proc-mcp { color: #b794f4; }
    .proc-tree .proc-receiver { color: #76e4f7; }
    .proc-tree .proc-orphan { color: #fc8181; }
    .proc-tree .proc-label { color: #718096; }
    .proc-tree .proc-summary { color: #f6e05e; font-weight: 600; }
    .session-id {
      font-family: monospace;
      font-size: 0.75rem;
      color: #a0aec0;
      word-break: break-all;
    }
    /* Agent status badges bar */
    .agents-bar {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-bottom: 20px;
    }
    .agent-badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      background: #1a202c;
      border: 1px solid #2d3748;
      border-radius: 6px;
      padding: 4px 12px;
      font-size: 0.8rem;
    }
    .agent-badge .agent-name { color: #90cdf4; font-weight: 600; }
    .agent-badge .dot-green { color: #68d391; }
    .agent-badge .dot-red { color: #fc8181; }

    /* Top row: Processes 70% | Agents 30%. Collapses to a single column on
       narrow screens (see media query below). */
    .top-grid {
      display: grid;
      grid-template-columns: 7fr 3fr;
      gap: 24px;
      align-items: start;
    }
    /* The Sessions table has 10 columns — too wide for phones. Wrap it so it
       scrolls horizontally instead of breaking the layout. */
    .table-wrap { width: 100%; overflow-x: auto; -webkit-overflow-scrolling: touch; }
    .table-wrap table { min-width: 820px; }

    /* ── Responsive breakpoints ──────────────────────────────────────────── */
    @media (max-width: 900px) {
      .top-grid { grid-template-columns: 1fr; gap: 16px; }
    }
    @media (max-width: 640px) {
      body { padding: 14px; }
      h1 { font-size: 1.2rem; }
      h2 { font-size: 1rem; }
      .meta { font-size: 0.78rem; }
      #refresh-indicator { float: none; display: block; margin-top: 4px; }
      .proc-tree { font-size: 0.72rem; padding: 10px 12px; }
      /* On phones allow horizontal pan only — no vertical clipping. */
    }
  </style>
</head>
<body>
  <h1><span class="rainbow">Claude Gateway</span> <span id="gateway-version" style="font-size:0.75rem;color:#718096;"></span> <span id="refresh-indicator">refreshing...</span> <button id="logout-btn" style="float:right;font-size:0.7rem;background:#2d3748;color:#a0aec0;border:1px solid #4a5568;border-radius:4px;padding:2px 8px;cursor:pointer;">Logout</button></h1>
  <div class="meta">
    Uptime: <span id="uptime">&mdash;</span> &nbsp;|&nbsp;
    Started: <span id="started-at">&mdash;</span> &nbsp;|&nbsp;
    Last updated: <span id="last-updated">&mdash;</span>
  </div>

  <!-- Row: Processes 70% | Agent badges 30% (collapses on narrow screens) -->
  <div class="top-grid">
    <div>
      <h2>Processes</h2>
      <div class="proc-tree" id="proc-tree">Loading...</div>
    </div>
    <div>
      <h2>Agents</h2>
      <div class="agents-bar" id="agents-bar"></div>
    </div>
  </div>

  <!-- PTY viewer — full width so the native 200-col terminal has room.
       Placed above the Sessions table so the live mirror is the first thing
       in view when streaming. -->
  <div class="pty-viewer" id="pty-viewer">
    <div class="pty-viewer-header">
      <span><span id="pty-title-text">Terminal Viewer</span> &mdash; <span class="agent-label" id="pty-agent-label"></span><span class="session-label" id="pty-session-label"></span></span>
      <span>
        <button class="pty-mode-toggle" id="pty-mode-toggle-btn" title="Toggle input mode (type into the live terminal)">&#x2328; View</button>
        <button class="pty-refresh" id="pty-refresh-btn" title="Refresh (reconnect &amp; redraw)">&#x21ba;</button>
        <button class="pty-close" id="pty-close-btn" title="Close">&#x2715;</button>
      </span>
    </div>
    <!-- tabindex makes the viewer keyboard-focusable so PageUp/PageDown reach it
         even in read-only view mode (xterm stdin is disabled there). -->
    <div id="pty-terminal" tabindex="0"></div>
  </div>

  <!-- Sessions — full width (session-centric, flat list) -->
  <h2>Sessions</h2>
  <div class="table-wrap">
    <table id="sessions-table">
      <thead>
        <tr>
          <th>Agent</th>
          <th>Session ID</th>
          <th>Chat ID</th>
          <th>Source</th>
          <th>Mode</th>
          <th>Model</th>
          <th>Tokens</th>
          <th>Status</th>
          <th>Uptime</th>
          <th>Spawned</th>
          <th>Shell</th>
        </tr>
      </thead>
      <tbody id="sessions-tbody">
        <tr><td colspan="11" class="ts">Loading...</td></tr>
      </tbody>
    </table>
  </div>

  <div id="error-msg" class="error" style="display:none;"></div>

  <script src="https://cdn.jsdelivr.net/npm/@xterm/xterm@6.0.0/lib/xterm.min.js"
    integrity="sha384-pELe6ZHtFxFcuYBq3gMkqvmnNIqUWnAYjBG5gThqQQCjWp8PJ/65MLK4lMIfEK1e" crossorigin="anonymous"></script>
  <script>
    // Auth is carried by the HttpOnly 'dash_session' cookie the browser sends
    // automatically on every same-origin request — no token is embedded in the
    // page (nothing for view-source/XSS to steal). If any read returns 401 the
    // session has expired or is missing, so bounce to /dashboard (login page).
    function onUnauthorized() {
      window.location.href = apiUrl('/dashboard');
    }

    // Must match the server PTY size (src/shell/screen.ts ScreenModel defaults).
    const PTY_COLS = 200;
    const PTY_ROWS = 50;

    function fmtUptime(seconds) {
      const h = Math.floor(seconds / 3600);
      const m = Math.floor((seconds % 3600) / 60);
      const s = seconds % 60;
      if (h > 0) return h + 'h ' + m + 'm ' + s + 's';
      if (m > 0) return m + 'm ' + s + 's';
      return s + 's';
    }

    // Spawned timestamp, formatted like "6/14/2026, 10:32:31 PM" (en-US, 12h).
    function fmtTs(ts) {
      if (!ts) return '<span class="ts">&mdash;</span>';
      try {
        const d = new Date(ts);
        return '<span class="ts">' + d.toLocaleString('en-US', {
          year: 'numeric', month: 'numeric', day: 'numeric',
          hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true
        }) + '</span>';
      } catch(e) { return ts; }
    }

    function basePath() {
      const p = window.location.pathname;
      if (p.endsWith('/dashboard')) return p.slice(0, -10);
      if (p.endsWith('/dashboard/')) return p.slice(0, -11);
      return p.endsWith('/') ? p.slice(0, -1) : p;
    }

    function apiUrl(path) {
      return basePath() + path;
    }

    async function wsPtyUrl(agentId, sessionId) {
      // Exchange the dashboard session (HttpOnly cookie, sent automatically) for a
      // short-lived ticket so no credential ever appears in the WS URL (which would
      // expose it in server logs and browser history). Per-session, so the session
      // id is always part of the request.
      const base = basePath() + '/api/v1/agents/' + encodeURIComponent(agentId) + '/pty-stream';
      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const r = await fetch(apiUrl('/api/v1/pty-stream-ticket'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId, sessionId }),
      });
      if (r.status === 401) { onUnauthorized(); return null; }
      if (!r.ok) throw new Error('ticket HTTP ' + r.status);
      const { ticket } = await r.json();
      return proto + '//' + window.location.host + base + '?ticket=' + ticket;
    }

    // ── PTY Viewer ───────────────────────────────────────────────────────────
    let term = null;
    let ptyWs = null;
    let currentPtyAgent = null;
    let currentPtySession = null;
    // Auto-reconnect state for the PTY viewer. The dashboard tab can lose its
    // WebSocket to a gateway restart, an idle timeout, or a transient network
    // blip; rather than make the user click View again, reconnect with backoff.
    let ptyReconnectTimer = null;
    let ptyReconnectAttempts = 0;
    const PTY_RECONNECT_MAX_MS = 10000;
    // Absolute cap so a session that ends without a clean 4404 (e.g. the gateway
    // is gone for good) doesn't retry every 10s forever. After this many failed
    // attempts in a row we give up and tell the user to click View again.
    const PTY_RECONNECT_MAX_ATTEMPTS = 10;
    // Streaming UTF-8 decoder. The PTY stream carries raw UTF-8 bytes (box-drawing
    // chars, spinner braille, emoji). Decoding them as latin1 mangles every
    // multi-byte char into noise — decode as UTF-8 with {stream:true} so sequences
    // split across WebSocket frames are reassembled instead of corrupted.
    let utf8Decoder = null;
    // Interactive input mode (Issue #201). When on, keystrokes typed into the
    // terminal are streamed to the live PTY over the same WebSocket. Off by
    // default (read-only mirror); the viewer flips it on via the mode toggle.
    let ptyInputMode = false;
    let ptyOnDataDisposable = null;

    // The agent's TUI enables mouse tracking (DECSET 1000/1002/1003/1006...).
    // While those modes are active, xterm.js forwards wheel/click events to the
    // app as mouse escapes, which can leave stray report bytes in the view. This
    // is a view-only mirror (disableStdin) so mouse reporting is useless here —
    // strip the set/reset sequences to keep the mirror clean.
    function stripMouseModes(s) {
      return s.replace(/\\x1b\\[\\?(1000|1001|1002|1003|1004|1005|1006|1015|1016)[hl]/g, '');
    }

    async function openPtyViewer(agentId, sessionId) {
      // Compare the SESSION, not the agent: one agent can have several sessions,
      // each its own stream. Guarding on agent alone made switching between two
      // sessions of the same agent a no-op (the viewer never reconnected).
      if (currentPtySession === sessionId && ptyWs && ptyWs.readyState === WebSocket.OPEN) return;
      closePtyViewer();

      currentPtyAgent = agentId;
      currentPtySession = sessionId;
      document.getElementById('pty-agent-label').textContent = agentId;
      // Append the session id after the agent name, e.g. "claude-founder · 3c01897c…".
      document.getElementById('pty-session-label').textContent = sessionId ? ' \\u00b7 ' + sessionId : '';
      document.getElementById('pty-viewer').style.display = 'block';
      // Always (re)open a fresh session in read-only view mode; the mode toggle
      // lets the viewer switch into interactive input on demand.
      setPtyInputMode(false);

      if (!term) {
        term = new Terminal({
          theme: { background: '#0d1117', foreground: '#e2e8f0', cursor: '#63b3ed' },
          fontSize: 11,
          lineHeight: 1.0,
          letterSpacing: 0,
          fontFamily: '"JetBrains Mono", "Cascadia Code", Menlo, Monaco, Consolas, "Courier New", monospace',
          fontWeight: 400,
          fontWeightBold: 600,
          // Fixed dimensions matching the server PTY — do NOT auto-fit, the
          // size mismatch is what makes the output unreadable.
          cols: PTY_COLS,
          rows: PTY_ROWS,
          // Alt-screen TUI has no scrollback (the live mirror only shows the
          // current screen), so don't retain any — this also removes the
          // non-functional vertical scrollbar.
          scrollback: 0,
          // View-only mirror of the agent's TUI.
          disableStdin: true,
          cursorBlink: false,
          convertEol: false,
        });
        term.open(document.getElementById('pty-terminal'));
        // After open(), xterm has measured cell height. Pin the container height
        // so all PTY_ROWS are always visible — prevents the alt-screen bottom rows
        // (cost bar, status line) from being clipped by parent overflow or viewport.
        requestAnimationFrame(function() {
          const screen = document.querySelector('#pty-terminal .xterm-screen');
          if (screen) {
            const h = screen.offsetHeight;
            if (h > 0) document.getElementById('pty-terminal').style.minHeight = h + 'px';
          }
        });
      } else {
        term.reset();
      }

      await connectPtyWs(agentId, sessionId);
    }

    // (Re)establish the WebSocket for the session the viewer is currently showing.
    // Split out from openPtyViewer so auto-reconnect can re-run just this part
    // without tearing down the terminal or flickering the panel.
    async function connectPtyWs(agentId, sessionId) {
      // Guard against a stale reconnect firing after the user closed/switched.
      if (currentPtySession !== sessionId) return;

      // Fresh decoder per (re)connect so a leftover partial byte can't corrupt
      // the first character of the freshly-replayed screen frame.
      utf8Decoder = new TextDecoder('utf-8');

      let url;
      try {
        url = await wsPtyUrl(agentId, sessionId);
      } catch (e) {
        // Ticket fetch failed (gateway momentarily unreachable) — retry.
        schedulePtyReconnect(agentId, sessionId);
        return;
      }
      // 401 → wsPtyUrl already bounced to the login page; stop here.
      if (!url) return;
      // The session may have been closed/switched while awaiting the ticket.
      if (currentPtySession !== sessionId) return;

      ptyWs = new WebSocket(url);
      ptyWs.binaryType = 'arraybuffer';

      ptyWs.onopen = function() { ptyReconnectAttempts = 0; };
      ptyWs.onmessage = function(ev) {
        const data = ev.data instanceof ArrayBuffer
          ? utf8Decoder.decode(ev.data, { stream: true })
          : ev.data;
        term.write(stripMouseModes(data));
      };
      ptyWs.onclose = function(ev) {
        ptyWs = null;
        // Viewer was closed or switched to another session — stop here.
        if (currentPtySession !== sessionId) return;
        // 4404 = the session is no longer running in PTY mode (it ended). No
        // point reconnecting; the server will never accept this stream again.
        if (ev.code === 4404) {
          if (term) term.writeln('\\r\\n\\x1b[33m[session ended]\\x1b[0m');
          return;
        }
        schedulePtyReconnect(agentId, sessionId);
      };
      // onerror is always followed by onclose, which owns the reconnect logic.
      ptyWs.onerror = function() {};
    }

    // Reconnect with capped exponential backoff (1s -> 10s). A single
    // "reconnecting" notice is shown per disconnect burst; the server replays a
    // clean frame on resubscribe, so the view redraws itself once we are back.
    function schedulePtyReconnect(agentId, sessionId) {
      if (ptyReconnectTimer) return;                // already pending
      if (currentPtySession !== sessionId) return;  // viewer no longer wants this
      if (ptyReconnectAttempts >= PTY_RECONNECT_MAX_ATTEMPTS) {
        if (term) term.writeln('\\r\\n\\x1b[31m[disconnected — click View to retry]\\x1b[0m');
        return;
      }
      if (ptyReconnectAttempts === 0 && term) {
        term.writeln('\\r\\n\\x1b[33m[reconnecting\\u2026]\\x1b[0m');
      }
      const delay = Math.min(1000 * Math.pow(2, ptyReconnectAttempts), PTY_RECONNECT_MAX_MS);
      ptyReconnectAttempts++;
      ptyReconnectTimer = setTimeout(function() {
        ptyReconnectTimer = null;
        void connectPtyWs(agentId, sessionId);
      }, delay);
    }

    function closePtyViewer() {
      // Cancel any pending reconnect and suppress the handlers on the socket we
      // are about to close intentionally, so it does not schedule a new one.
      if (ptyReconnectTimer) { clearTimeout(ptyReconnectTimer); ptyReconnectTimer = null; }
      ptyReconnectAttempts = 0;
      setPtyInputMode(false); // always leave input mode when closing/switching
      if (ptyWs) { ptyWs.onclose = null; ptyWs.onerror = null; ptyWs.close(); ptyWs = null; }
      currentPtyAgent = null;
      currentPtySession = null;
      document.getElementById('pty-viewer').style.display = 'none';
    }

    // Switch the viewer between read-only mirror and interactive input. In input
    // mode the terminal accepts stdin and every keystroke (printable chars,
    // Enter, arrows, Ctrl-combos, Esc) is streamed to the live PTY over the WS,
    // like a real terminal; the title and toggle reflect the active mode.
    function setPtyInputMode(on) {
      if (!term) on = false;
      ptyInputMode = !!on;
      const toggleBtn = document.getElementById('pty-mode-toggle-btn');
      const titleEl = document.getElementById('pty-title-text');
      if (term) term.options.disableStdin = !ptyInputMode;
      // Detach any previous onData listener before (re)attaching, so toggling
      // off — or toggling on twice — never leaves a duplicate keystroke stream.
      if (ptyOnDataDisposable) { ptyOnDataDisposable.dispose(); ptyOnDataDisposable = null; }
      if (ptyInputMode && term) {
        ptyOnDataDisposable = term.onData(function(data) {
          if (ptyWs && ptyWs.readyState === WebSocket.OPEN) ptyWs.send(data);
        });
      }
      if (titleEl) titleEl.textContent = ptyInputMode ? 'Interactive Terminal' : 'Terminal Viewer';
      if (toggleBtn) {
        toggleBtn.innerHTML = ptyInputMode ? '\\u2328 Input' : '\\u2328 View';
        toggleBtn.classList.toggle('input-active', ptyInputMode);
        toggleBtn.title = ptyInputMode
          ? 'Input mode — keystrokes go to the live terminal (click for read-only)'
          : 'Toggle input mode (type into the live terminal)';
      }
      if (ptyInputMode && term) {
        term.focus(); // typing goes to xterm's textarea
      } else {
        // View mode: focus the container (tabindex) so PageUp/PageDown reach our
        // key handler instead of scrolling the browser page.
        const host = document.getElementById('pty-terminal');
        if (host) host.focus();
      }
    }

    function togglePtyInputMode() {
      setPtyInputMode(!ptyInputMode);
    }

    // Refresh: force a clean reconnect of the CURRENT session. The server replays
    // a freshly-serialized screen frame on subscribe, so this redraws from a clean
    // xterm state — a manual escape hatch if the live stream ever drifts.
    async function refreshPtyViewer() {
      const agentId = currentPtyAgent;
      const sessionId = currentPtySession;
      if (!agentId) return;
      closePtyViewer();
      await openPtyViewer(agentId, sessionId);
    }

    // Page Up / Page Down keys (Issue #201): the alt-screen mirror keeps no
    // scrollback of its own, so a physical PageUp/PageDown key is forwarded to the
    // live TUI — which holds the history and scrolls itself. In read-only view mode
    // xterm's stdin is disabled, so without this those keys would just scroll the
    // browser page; here we intercept ONLY these two keys (never printable input)
    // and send them to the PTY, so the user can page through earlier output without
    // enabling the interactive keyboard. In input mode xterm already forwards them
    // via onData, so we skip to avoid double-send.
    //
    // The listener is attached to the document, NOT the viewer container: xterm renders
    // its own focusable helpers inside #pty-terminal, and with disableStdin the
    // container rarely holds focus reliably (a reconnect or stray click drops it),
    // so a container-scoped keydown silently missed the keys. Gating on the viewer
    // being open + view mode keeps it from hijacking PageUp elsewhere on the page,
    // and we bail when focus is in a real text field so form paging still works.
    // \\x1b[5~ = PageUp, \\x1b[6~ = PageDown.
    function forwardPageKey(e) {
      if (e.key !== 'PageUp' && e.key !== 'PageDown') return;
      if (ptyInputMode) return; // input mode: xterm.onData already sends it
      // Only while THIS viewer is actually open with a live socket.
      const viewer = document.getElementById('pty-viewer');
      if (!viewer || viewer.style.display === 'none') return;
      if (!ptyWs || ptyWs.readyState !== WebSocket.OPEN) return;
      // Don't steal paging from a genuine editable field (none in view mode today,
      // but keep the guard so the document-level listener stays well-behaved).
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || (t.tagName === 'TEXTAREA' && !t.disabled) || t.isContentEditable)) return;
      e.preventDefault();
      ptyWs.send(e.key === 'PageUp' ? '\\x1b[5~' : '\\x1b[6~');
    }
    document.addEventListener('keydown', forwardPageKey);

    document.getElementById('pty-close-btn').addEventListener('click', closePtyViewer);
    document.getElementById('pty-refresh-btn').addEventListener('click', function() { void refreshPtyViewer(); });
    document.getElementById('pty-mode-toggle-btn').addEventListener('click', togglePtyInputMode);

    // Event delegation for Live buttons (avoids inline onclick + HTML injection)
    document.getElementById('sessions-tbody').addEventListener('click', function(e) {
      const btn = e.target.closest('.btn-stream');
      if (btn) void openPtyViewer(btn.getAttribute('data-agent-id'), btn.getAttribute('data-session-id'));
    });

    function escHtml(s) {
      return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }

    function modeBadge(mode) {
      if (mode === 'pty-shell') return '<span class="badge badge-blue">wrap-shell</span>';
      if (mode === 'headless') return '<span class="badge badge-purple">headless</span>';
      return '<span class="ts">' + escHtml(mode || '?') + '</span>';
    }

    // Source badge with a per-channel color: telegram=blue, discord=purple,
    // api=gray. Unknown sources fall back to gray.
    function sourceBadge(source) {
      const s = String(source || '?').toLowerCase();
      if (s === 'telegram') return '<span class="badge badge-blue">telegram</span>';
      if (s === 'discord') return '<span class="badge badge-purple">discord</span>';
      if (s === 'api') return '<span class="badge badge-gray">api</span>';
      return '<span class="badge badge-gray">' + escHtml(source || '?') + '</span>';
    }

    // Prettify a model id for display: drop the "claude-" prefix and any
    // trailing date stamp, e.g. claude-haiku-4-5-20251001 -> haiku-4-5.
    // Each model family gets a distinct badge color; full id kept in the tooltip.
    function fmtModel(m) {
      if (!m) return '<span class="ts">&mdash;</span>';
      const id = String(m);
      const label = id.replace(/^claude-/, '').replace(/-\\d{8}$/, '');
      let cls = 'badge-model';
      if (/opus/i.test(id)) cls = 'badge-opus';
      else if (/sonnet/i.test(id)) cls = 'badge-sonnet';
      else if (/haiku/i.test(id)) cls = 'badge-haiku';
      else if (/fable/i.test(id)) cls = 'badge-fable';
      return '<span class="badge ' + cls + '" title="' + escHtml(id) + '">' + escHtml(label) + '</span>';
    }

    // Format a context-window token count compactly: 1234 -> "1.2k", 45000 -> "45k".
    // Full value is kept in the tooltip. 0/unknown renders as a dash.
    function fmtTokens(n) {
      const v = Number(n) || 0;
      if (v <= 0) return '<span class="ts">&mdash;</span>';
      const label = v >= 1000 ? (v / 1000).toFixed(v >= 10000 ? 0 : 1) + 'k' : String(v);
      return '<span title="' + v.toLocaleString() + ' tokens">' + label + '</span>';
    }

    // ── Status Refresh ────────────────────────────────────────────────────────
    async function refresh() {
      document.getElementById('refresh-indicator').textContent = 'refreshing...';
      try {
        const res = await fetch(apiUrl('/status'));
        if (res.status === 401) { onUnauthorized(); return; }
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const data = await res.json();

        document.getElementById('uptime').textContent = fmtUptime(data.uptime || 0);
        document.getElementById('started-at').textContent = data.startedAt
          ? new Date(data.startedAt).toLocaleString() : '\\u2014';
        document.getElementById('last-updated').textContent = new Date().toLocaleTimeString();
        if (data.version) document.getElementById('gateway-version').textContent = 'v' + data.version;
        document.getElementById('error-msg').style.display = 'none';

        const agents = data.agents || [];

        // Agent badges bar.
        // Green = available. An agent with a channel receiver (telegram/discord)
        // is green only while its receiver is running; API-only agents have no
        // receiver, so they are always green as long as the gateway loaded them.
        // Red = a channel agent whose receiver is down (genuinely stopped).
        const badges = agents.map(function(a) {
          const ok = a.hasChannel ? a.isRunning : true;
          const dot = ok ? '<span class="dot-green">&#x25CF;</span>' : '<span class="dot-red">&#x25CF;</span>';
          return '<span class="agent-badge">' + dot + ' <span class="agent-name">' + escHtml(a.id) + '</span></span>';
        });
        document.getElementById('agents-bar').innerHTML = badges.join('') || '<span class="ts">No agents</span>';

        // Sessions table — flat, session-centric. One row per real session across
        // all agents; agents with no session do not produce a row.
        const rows = [];
        agents.forEach(function(a) {
          (a.sessions || []).forEach(function(s) {
            const statusBadge = s.isRunning
              ? '<span class="badge badge-green">running</span>'
              : '<span class="badge badge-gray">stopped</span>';
            const uptime = s.isRunning ? fmtUptime(s.uptimeSec || 0) : '<span class="ts">&mdash;</span>';
            const sessId = s.sessionId
              ? '<span class="session-id">' + escHtml(s.sessionId) + '</span>'
              : '<span class="ts">&mdash;</span>';
            const chatCell = s.chatId
              ? '<span class="session-id">' + escHtml(String(s.chatId)) + '</span>'
              : '<span class="ts">&mdash;</span>';
            const liveBtn = (s.hasPtyStream && s.isRunning && s.mode === 'pty-shell')
              ? '<button class="btn-stream" data-agent-id="' + escHtml(a.id) + '" data-session-id="' + escHtml(s.sessionId || '') + '">💻 View</button>'
              : '<span class="ts">&mdash;</span>';
            rows.push(
              '<tr class="session-row">' +
              '<td><span style="color:#90cdf4;font-weight:600;">' + escHtml(a.id) + '</span></td>' +
              '<td>' + sessId + '</td>' +
              '<td>' + chatCell + '</td>' +
              '<td>' + sourceBadge(s.source) + '</td>' +
              '<td>' + modeBadge(s.mode) + '</td>' +
              '<td>' + fmtModel(s.model) + '</td>' +
              '<td>' + fmtTokens(s.tokens) + '</td>' +
              '<td>' + statusBadge + '</td>' +
              '<td>' + uptime + '</td>' +
              '<td>' + fmtTs(s.spawnedAt ? new Date(s.spawnedAt).toISOString() : null) + '</td>' +
              '<td>' + liveBtn + '</td>' +
              '</tr>'
            );
          });
        });

        document.getElementById('sessions-tbody').innerHTML =
          rows.length ? rows.join('') : '<tr><td colspan="11" class="ts">No active sessions</td></tr>';

        document.getElementById('refresh-indicator').textContent = 'auto-refresh 3s';
      } catch(e) {
        document.getElementById('error-msg').textContent = 'Error fetching status: ' + e.message;
        document.getElementById('error-msg').style.display = 'block';
        document.getElementById('refresh-indicator').textContent = 'error';
      }
    }

    // ── Process Tree ─────────────────────────────────────────────────────────
    async function refreshProcesses() {
      try {
        const res = await fetch(apiUrl('/processes'));
        if (res.status === 401) { onUnauthorized(); return; }
        if (!res.ok) return;
        const data = await res.json();
        renderProcessTree(data.processes || [], data.numCpus || 1);
      } catch(e) {
        document.getElementById('proc-tree').textContent = 'Error: ' + e.message;
      }
    }

    function renderProcessTree(procs, numCpus) {
      if (!procs.length) {
        document.getElementById('proc-tree').textContent = '— no gateway processes found —';
        return;
      }

      const pidMap = {};
      procs.forEach(function(p) { pidMap[p.pid] = p; });

      // Aggregate resource usage across the whole gateway process tree.
      // ps %cpu is per-core (100% = 1 core), so divide by numCpus to get
      // a normalized 0–100% load figure across all available cores.
      // RSS is summed and may slightly over-count shared pages.
      let rawCpuSum = 0, totalRssKb = 0;
      procs.forEach(function(p) {
        rawCpuSum += Number(p.cpu) || 0;
        totalRssKb += Number(p.rssKb) || 0;
      });
      const totalCpu = rawCpuSum / (numCpus || 1);
      const totalMemMb = totalRssKb / 1024;
      const memStr = totalMemMb >= 1024
        ? (totalMemMb / 1024).toFixed(2) + ' GB'
        : totalMemMb.toFixed(0) + ' MB';

      function cat(p) {
        const a = p.args;
        if (a.includes('node') && a.includes('dist/index')) return 'orchestrator';
        if (a.includes('claude-pty-shell')) return 'pty';
        if (a.includes('bun') && a.includes('mcp/server')) return 'mcp';
        if (a.includes('bun') && a.includes('telegram') && a.includes('receiver')) return 'telegram';
        if (a.includes('bun') && a.includes('discord') && a.includes('receiver')) return 'discord';
        if (a.includes('--mcp-config') && (a.includes('--session-id') || a.includes('--print'))) {
          if (a.includes('--session-id')) {
            const parent = pidMap[p.ppid];
            return (parent && cat(parent) === 'pty') ? 'claude-pty' : 'claude-headless';
          }
          return 'claude-headless';
        }
        return 'other';
      }

      // Show full command lines (no truncation) — text wraps inside the box.
      function full(args) {
        return escHtml(args);
      }

      function sessionId(args) {
        const m = args.match(/--session-id\\s+(\\S+)/);
        return m ? escHtml(m[1]) : '?';
      }

      function agentName(args) {
        const m = args.match(/agents\\/([^/]+)\\/workspace/);
        return m ? m[1] : '?';
      }

      const lines = [];
      // First line: total resource usage across the whole gateway tree.
      lines.push(
        '<span class="proc-summary">' +
        '\\u2211 ' + procs.length + ' procs' +
        '  \\u00b7  CPU ' + totalCpu.toFixed(1) + '%' +
        '  \\u00b7  MEM ' + memStr +
        '</span>'
      );
      lines.push('');
      const orchestrator = procs.find(function(p) { return cat(p) === 'orchestrator'; });
      const ptys = procs.filter(function(p) { return cat(p) === 'pty'; });
      const headless = procs.filter(function(p) { return cat(p) === 'claude-headless'; });
      const telegramReceivers = procs.filter(function(p) { return cat(p) === 'telegram'; });
      const discordReceivers = procs.filter(function(p) { return cat(p) === 'discord'; });
      const mcpServers = procs.filter(function(p) { return cat(p) === 'mcp'; });

      const gatewayPids = new Set(procs.map(function(p) { return p.pid; }));
      const orphans = procs.filter(function(p) {
        const c = cat(p);
        return (c === 'claude-pty' || c === 'claude-headless' || c === 'pty' || c === 'mcp')
          && !gatewayPids.has(p.ppid)
          && p.pid !== (orchestrator && orchestrator.pid);
      });

      if (orchestrator) {
        lines.push('<span class="proc-orchestrator">Orchestrator</span>');
        lines.push('  PID ' + orchestrator.pid + '  <span class="proc-orchestrator">' + full(orchestrator.args) + '</span>');
        lines.push('');
      }

      const sessionCount = ptys.length + headless.length;
      lines.push('<span class="proc-label">Sessions (' + sessionCount + ')</span>');

      ptys.forEach(function(pty) {
        const agent = agentName(pty.args);
        lines.push('  PID ' + pty.pid + '  <span class="proc-pty">wrap-shell</span>  [' + agent + ']');
        const claudeChild = procs.find(function(p) { return p.ppid === pty.pid && cat(p) === 'claude-pty'; });
        if (claudeChild) {
          lines.push('  \\u2514\\u2500 PID ' + claudeChild.pid + '  <span class="proc-claude">claude ' + sessionId(claudeChild.args) + '</span>');
          const mcp = mcpServers.find(function(p) { return p.ppid === claudeChild.pid; });
          if (mcp) {
            lines.push('     \\u2514\\u2500 PID ' + mcp.pid + '  <span class="proc-mcp">mcp</span>');
          }
        }
      });

      headless.forEach(function(cl) {
        const agent = agentName(cl.args);
        lines.push('  PID ' + cl.pid + '  <span class="proc-claude">claude --print</span>' + (agent !== '?' ? '  [' + agent + ']' : ''));
        const mcp = mcpServers.find(function(p) { return p.ppid === cl.pid; });
        if (mcp) {
          lines.push('  \\u2514\\u2500 PID ' + mcp.pid + '  <span class="proc-mcp">mcp</span>');
        }
      });

      if (sessionCount === 0) lines.push('  <span class="ts">\\u2014 none \\u2014</span>');
      lines.push('');

      lines.push('<span class="proc-label">Receivers</span>');
      if (telegramReceivers.length) lines.push('  Telegram \\u00d7' + telegramReceivers.length);
      if (discordReceivers.length) lines.push('  Discord \\u00d7' + discordReceivers.length);
      if (!telegramReceivers.length && !discordReceivers.length) lines.push('  <span class="ts">\\u2014 none \\u2014</span>');
      lines.push('');

      lines.push('<span class="proc-label">Orphans</span>');
      if (orphans.length) {
        orphans.forEach(function(p) {
          lines.push('  \\u26a0 PID ' + p.pid + '  <span class="proc-orphan">' + full(p.args) + '</span>');
        });
      } else {
        lines.push('  <span class="ts">none \\u2705</span>');
      }

      document.getElementById('proc-tree').innerHTML = lines.join('\\n');
    }

    // Logout — revoke the session cookie server-side, then land on the login page.
    document.getElementById('logout-btn').addEventListener('click', async function() {
      try {
        await fetch(apiUrl('/dashboard/logout'), { method: 'POST' });
      } catch (e) { /* best-effort; navigate regardless */ }
      window.location.href = apiUrl('/dashboard');
    });

    refresh();
    refreshProcesses();
    setInterval(refresh, 3000);
    // Process tree (with CPU/mem) is heavier (spawns ps) — refresh a bit slower.
    setInterval(refreshProcesses, 6000);
  </script>
</body>
</html>`;
}

/**
 * Minimal, self-contained login page served at GET /dashboard when API keys are
 * configured and the request has no valid dashboard session cookie. Posts the
 * entered API key to POST /dashboard/login (JSON); on success the server sets the
 * HttpOnly session cookie and we reload into the dashboard. No external deps.
 */
export function generateLoginHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Claude Gateway — Login</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, monospace;
      background: #0f1117; color: #e2e8f0;
      min-height: 100vh; display: flex; align-items: center; justify-content: center;
    }
    .card {
      background: #1a202c; border: 1px solid #2d3748; border-radius: 10px;
      padding: 32px; width: 100%; max-width: 360px;
    }
    h1 { font-size: 1.25rem; margin-bottom: 4px; }
    .sub { font-size: 0.8rem; color: #718096; margin-bottom: 20px; }
    label { display: block; font-size: 0.75rem; color: #a0aec0; margin-bottom: 6px; }
    input {
      width: 100%; padding: 10px 12px; border-radius: 6px;
      border: 1px solid #2d3748; background: #0f1117; color: #e2e8f0;
      font-family: inherit; font-size: 0.9rem;
    }
    button {
      width: 100%; margin-top: 16px; padding: 10px; border: none; border-radius: 6px;
      background: #3182ce; color: #fff; font-weight: 600; font-size: 0.9rem; cursor: pointer;
    }
    button:hover { background: #2b6cb0; }
    #err { color: #fc8181; font-size: 0.8rem; margin-top: 12px; min-height: 1em; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Claude Gateway</h1>
    <div class="sub">Enter an API key to access the dashboard.</div>
    <form id="login-form" autocomplete="off">
      <label for="key">API key</label>
      <input id="key" type="password" placeholder="sk-gateway-..." autofocus>
      <button type="submit">Sign in</button>
      <div id="err"></div>
    </form>
  </div>
  <script>
    function basePath() {
      var p = window.location.pathname;
      if (p.endsWith('/dashboard')) return p.slice(0, -10);
      if (p.endsWith('/dashboard/')) return p.slice(0, -11);
      return p.endsWith('/') ? p.slice(0, -1) : p;
    }
    document.getElementById('login-form').addEventListener('submit', async function(e) {
      e.preventDefault();
      var err = document.getElementById('err');
      err.textContent = '';
      var key = document.getElementById('key').value;
      try {
        var res = await fetch(basePath() + '/dashboard/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ key: key }),
        });
        if (res.ok) { window.location.href = basePath() + '/dashboard'; return; }
        err.textContent = res.status === 401 ? 'Invalid API key.' : ('Login failed (HTTP ' + res.status + ').');
      } catch (e2) {
        err.textContent = 'Network error.';
      }
    });
  </script>
</body>
</html>`;
}
