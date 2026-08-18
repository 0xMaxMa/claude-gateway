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

    /* --- Tabs (Sessions | Knowledge base) --- */
    .tabs { display: flex; gap: 4px; margin: 14px 0 18px; border-bottom: 1px solid #2d3748; }
    .tab {
      background: none; border: none; border-bottom: 2px solid transparent;
      color: #a0aec0; font-size: 0.9rem; font-weight: 600; padding: 8px 16px;
      cursor: pointer; margin-bottom: -1px;
    }
    .tab:hover { color: #e2e8f0; }
    .tab.active { color: #63b3ed; border-bottom-color: #63b3ed; }

    /* --- Knowledge Base graph view --- */
    .kb-toolbar {
      display: flex; align-items: center; gap: 14px; flex-wrap: wrap;
      margin-bottom: 10px; font-size: 0.8rem; color: #a0aec0;
    }
    .kb-toolbar button {
      background: #2d3748; color: #e2e8f0; border: 1px solid #4a5568;
      border-radius: 4px; padding: 4px 10px; cursor: pointer; font-size: 0.8rem;
    }
    .kb-toolbar button:hover { background: #374151; }
    .kb-toolbar label { display: inline-flex; align-items: center; gap: 5px; cursor: pointer; }
    #kb-demo-size, #kb-source {
      background: #1a2333; color: #cbd5e0; border: 1px solid #2d3748;
      border-radius: 4px; padding: 2px 4px; font-size: 0.78rem; cursor: pointer;
    }
    .kb-demo-badge {
      background: #744210; color: #fbd38d; border: 1px solid #975a16;
      border-radius: 4px; padding: 2px 8px; font-size: 0.72rem; font-weight: 600;
    }
    .kb-legend { display: inline-flex; gap: 10px; flex-wrap: wrap; }
    .kb-legend span { display: inline-flex; align-items: center; gap: 4px; }
    .kb-legend i { width: 10px; height: 10px; border-radius: 50%; display: inline-block; }
    .kb-stage {
      position: relative; width: 100%; height: 620px; overflow: hidden;
      border: 1px solid #2d3748; border-radius: 8px;
      /* Deep-space radial backdrop makes the node glow read as light. */
      background: radial-gradient(ellipse 70% 62% at 50% 42%, #16203a 0%, #0d1322 55%, #070a12 100%);
    }
    #kb-svg { width: 100%; height: 100%; display: block; cursor: grab; touch-action: none; }
    #kb-svg.panning { cursor: grabbing; }
    /* Curved links: calm and thin at rest; energised with a flowing dash on hover. */
    .kb-edge { fill: none; stroke: #34405c; stroke-width: 1.1; stroke-linecap: round;
      transition: stroke 0.15s ease, opacity 0.15s ease; }
    .kb-edge.hl { stroke: #7cc4ff; stroke-width: 2.2; stroke-dasharray: 3 7;
      animation: kb-flow 0.55s linear infinite; }
    .kb-edge.dim { opacity: 0.05; }
    @keyframes kb-flow { to { stroke-dashoffset: -20; } }
    /* #kb-halos is a blurred layer (filter below) giving each node an Obsidian-style bloom. */
    #kb-halos circle { pointer-events: none; }
    #kb-halos circle.dim { opacity: 0.04; }
    .kb-node { cursor: pointer; }
    .kb-node circle { stroke: rgba(255,255,255,0.35); stroke-width: 1; transition: opacity 0.15s; }
    .kb-node.contradiction circle { stroke: #fc8181; stroke-width: 2.5; }
    /* paint-order draws the dark stroke UNDER the glyph so labels stay legible over glow. */
    .kb-node text { fill: #d5deec; font-size: 11px; pointer-events: none;
      paint-order: stroke; stroke: #070a12; stroke-width: 3px; stroke-linejoin: round; }
    /* Declutter at scale: hide labels until a node is focused (hover) or a search hit. */
    #kb-nodes.declutter .kb-node text { opacity: 0; transition: opacity 0.12s; }
    #kb-nodes.declutter .kb-node.focus text,
    #kb-nodes.declutter .kb-node.search-hit text { opacity: 1; }
    .kb-node.stale { opacity: 0.4; }
    .kb-node.dim { opacity: 0.1; }
    /* Search: dim non-matches (independent of hover 'dim'), ring the matches. */
    .kb-node.search-dim { opacity: 0.08; }
    #kb-halos circle.search-dim { opacity: 0.02; }
    .kb-edge.search-dim { opacity: 0.03; }
    .kb-node.search-hit circle { stroke: #f6e05e; stroke-width: 3; }
    .kb-node.search-hit text { fill: #f6e05e; }
    .kb-search-wrap { position: relative; display: inline-flex; align-items: center; gap: 6px; }
    #kb-search {
      background: #0d1117; color: #e2e8f0; border: 1px solid #4a5568; border-radius: 4px;
      padding: 3px 8px; font-size: 0.8rem; width: 160px; outline: none;
    }
    #kb-search:focus { border-color: #63b3ed; }
    .kb-search-count { color: #718096; font-size: 0.75rem; min-width: 42px; }
    .kb-empty {
      position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
      color: #718096; font-size: 0.9rem; text-align: center; padding: 20px; pointer-events: none;
    }
    /* --- Nightly dreaming report --- */
    .dreams-list { display: flex; flex-direction: column; gap: 12px; padding: 4px 2px 20px; }
    .dreams-empty { color: #718096; font-size: 0.9rem; text-align: center; padding: 40px 20px; }
    .dream-run {
      background: #131a2b; border: 1px solid #222c40; border-radius: 8px; padding: 12px 14px;
    }
    .dream-run-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 6px; }
    .dream-run-head .agent { color: #63b3ed; font-weight: 600; }
    .dream-run-head .when { color: #718096; font-size: 0.78rem; font-family: monospace; }
    .dream-badge { border-radius: 4px; padding: 1px 7px; font-size: 0.7rem; font-weight: 600; }
    .dream-badge.auto { background: #22543d; color: #9ae6b4; border: 1px solid #2f855a; }
    .dream-badge.propose { background: #2a4365; color: #90cdf4; border: 1px solid #2b6cb0; }
    .dream-badge.outcome { background: #2d3748; color: #cbd5e0; border: 1px solid #4a5568; }
    .dream-summary { color: #cbd5e0; font-size: 0.86rem; margin: 4px 0 8px; }
    .dream-meta { color: #718096; font-size: 0.75rem; margin-top: 8px; }
    .dream-props { display: flex; flex-direction: column; gap: 6px; }
    .dream-prop {
      background: #0e1420; border: 1px solid #1e2740; border-radius: 6px; padding: 7px 9px; font-size: 0.82rem;
    }
    .dream-prop .op { font-weight: 600; text-transform: uppercase; font-size: 0.7rem; margin-right: 6px; }
    .dream-prop .op.add { color: #68d391; } .dream-prop .op.replace { color: #f6ad55; } .dream-prop .op.remove { color: #fc8181; }
    .dream-prop .file { color: #90cdf4; font-family: monospace; font-size: 0.76rem; }
    .dream-prop .score { color: #718096; font-size: 0.72rem; float: right; }
    .dream-prop .reason { color: #a0aec0; margin-top: 3px; }
    .dream-prop .content { color: #cbd5e0; margin-top: 5px; white-space: pre-wrap; word-break: break-word;
      background: #070a12; border-radius: 4px; padding: 6px 8px; font-size: 0.78rem; max-height: 140px; overflow: auto; }
    .kb-panel {
      position: absolute; top: 10px; right: 10px; width: 280px; max-height: calc(100% - 20px);
      overflow-y: auto; background: #1a202c; border: 1px solid #4a5568; border-radius: 8px;
      padding: 14px; font-size: 0.8rem; color: #cbd5e0; box-shadow: 0 6px 20px rgba(0,0,0,0.4);
    }
    .kb-panel h3 { margin: 0 0 8px; font-size: 0.95rem; color: #e2e8f0; }
    .kb-panel .kb-panel-close { float: right; cursor: pointer; color: #718096; }
    .kb-panel dt { color: #718096; margin-top: 8px; }
    .kb-panel dd { margin: 2px 0 0; word-break: break-word; }
    .kb-panel-note-h {
      margin-top: 12px; padding-top: 10px; border-top: 1px solid #2d3748;
      color: #718096; text-transform: uppercase; font-size: 0.68rem; letter-spacing: 0.06em;
    }
    .kb-panel-note {
      margin-top: 6px; color: #cbd5e0; line-height: 1.5; white-space: pre-wrap; word-break: break-word;
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

  <!-- Tab switcher: Sessions (live PTY + table) | Knowledge base (shared-KB graph) -->
  <div class="tabs">
    <button class="tab active" id="tab-sessions" data-view="view-sessions">Sessions</button>
    <button class="tab" id="tab-kb" data-view="view-kb">Knowledge base</button>
    <button class="tab" id="tab-dreams" data-view="view-dreams">Nightly dreaming</button>
  </div>

  <div id="view-sessions" class="view">
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
  </div><!-- /view-sessions -->

  <!-- Knowledge base — Obsidian-style force-directed graph over the shared vault.
       Zero external deps: the force simulation + SVG render are hand-rolled. -->
  <div id="view-kb" class="view" style="display:none;">
    <div class="kb-toolbar">
      <label id="kb-source-wrap" title="Which memory graph to view: the cross-agent Shared KB, or one agent's own memory">Source
        <select id="kb-source"><option value="shared">Shared KB</option></select>
      </label>
      <button id="kb-refresh" title="Recompute the graph from the selected source">&#x21bb; Refresh</button>
      <span class="kb-search-wrap">
        <input id="kb-search" type="search" placeholder="Search notes&hellip;" autocomplete="off" spellcheck="false">
        <span id="kb-search-count" class="kb-search-count"></span>
      </span>
      <label><input type="checkbox" id="kb-demo-toggle" checked> Show demo data when vault is empty</label>
      <label id="kb-demo-size-wrap" title="Synthetic node count for the demo (stress-test the viewer at scale)">Demo size
        <select id="kb-demo-size">
          <option value="0">8 (sample)</option>
          <option value="100">100</option>
          <option value="300">300</option>
          <option value="600">600</option>
        </select>
      </label>
      <span id="kb-demo-badge" class="kb-demo-badge" style="display:none;">DEMO DATA</span>
      <span id="kb-stats"></span>
      <span class="kb-legend" id="kb-legend"></span>
    </div>
    <div class="kb-stage">
      <svg id="kb-svg" xmlns="http://www.w3.org/2000/svg">
        <defs>
          <filter id="kb-glow" x="-60%" y="-60%" width="220%" height="220%">
            <feGaussianBlur stdDeviation="6"></feGaussianBlur>
          </filter>
        </defs>
        <!-- Full-bleed transparent surface (screen-space, OUTSIDE the panned viewport)
             so empty-area drags reliably hit the SVG for panning in every browser. -->
        <rect id="kb-bg" x="0" y="0" width="100%" height="100%" fill="transparent" pointer-events="all"></rect>
        <g id="kb-viewport">
          <g id="kb-halos" filter="url(#kb-glow)"></g>
          <g id="kb-edges"></g>
          <g id="kb-nodes"></g>
        </g>
      </svg>
      <div id="kb-empty" class="kb-empty" style="display:none;"></div>
      <div id="kb-panel" class="kb-panel" style="display:none;"></div>
    </div>
  </div><!-- /view-kb -->

  <!-- Nightly dreaming — the memory-consolidation audit trail (.dreaming/) per agent. -->
  <div id="view-dreams" class="view" style="display:none;">
    <div class="kb-toolbar">
      <button id="dreams-refresh" title="Reload the dreaming audit trail">&#x21bb; Refresh</button>
      <label id="dreams-agent-wrap">Agent
        <select id="dreams-agent"><option value="">All agents</option></select>
      </label>
      <span id="dreams-stats"></span>
    </div>
    <div id="dreams-list" class="dreams-list"></div>
    <div id="dreams-empty" class="dreams-empty" style="display:none;"></div>
  </div><!-- /view-dreams -->

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

  <!-- Knowledge base graph: tab switching + hand-rolled force-directed renderer.
       No template literals here (this file is itself a template literal). -->
  <script id="kb-graph">
  (function(){
    // ---------- Tab switching ----------
    var tabs = document.querySelectorAll('.tab');
    var kbLoaded = false;
    tabs.forEach(function(tab){
      tab.addEventListener('click', function(){
        tabs.forEach(function(t){ t.classList.remove('active'); });
        tab.classList.add('active');
        document.querySelectorAll('.view').forEach(function(v){ v.style.display = 'none'; });
        var viewEl = document.getElementById(tab.getAttribute('data-view'));
        if (viewEl) viewEl.style.display = '';
        if (tab.getAttribute('data-view') === 'view-kb' && !kbLoaded) { kbLoaded = true; loadSources(); }
        if (tab.getAttribute('data-view') === 'view-dreams' && window.__loadDreams) { window.__loadDreams(); }
      });
    });

    // ---------- Graph elements + constants ----------
    var SVGNS = 'http://www.w3.org/2000/svg';
    var svg = document.getElementById('kb-svg');
    var gViewport = document.getElementById('kb-viewport');
    var gHalos = document.getElementById('kb-halos');
    var gEdges = document.getElementById('kb-edges');
    var gNodes = document.getElementById('kb-nodes');
    var elEmpty = document.getElementById('kb-empty');
    var elPanel = document.getElementById('kb-panel');
    var elStats = document.getElementById('kb-stats');
    var elLegend = document.getElementById('kb-legend');
    var elDemoBadge = document.getElementById('kb-demo-badge');
    var sourceSel = document.getElementById('kb-source');
    var demoToggle = document.getElementById('kb-demo-toggle');
    var demoToggleWrap = demoToggle ? demoToggle.closest('label') : null;
    var demoSize = document.getElementById('kb-demo-size');
    var demoSizeWrap = document.getElementById('kb-demo-size-wrap');
    var elSearch = document.getElementById('kb-search');
    var elSearchCount = document.getElementById('kb-search-count');

    var TYPE_COLORS = {
      decision: '#63b3ed', evidence: '#68d391', claim: '#f6ad55',
      policy: '#b794f4', infra: '#4fd1c5', fact: '#f687b3'
    };
    var DEFAULT_COLOR = '#a0aec0';
    function colorFor(type){ return (type && TYPE_COLORS[type]) ? TYPE_COLORS[type] : DEFAULT_COLOR; }

    // Force constants — tuned for the small KB (tens of nodes). Wider REST + REPULSE
    // give an airy, un-clumped layout; higher friction (lower DAMPING) + low VMAX kill
    // the "bouncy" overshoot so the graph settles instead of jiggling.
    var REPULSE = 4200, SPRING_K = 0.025, REST = 135, CENTER = 0.02, DAMPING = 0.82, VMAX = 18;
    var PRESOLVE_TICKS = 220; // lay the graph out off-screen so it opens already-settled
    var LABEL_LIMIT = 60; // above this node count, labels are hidden until hover/search (declutter)

    var nodes = [], edges = [], nodeById = {};
    var view = { x: 0, y: 0, k: 1 };
    var raf = null, alpha = 0, dragNode = null, panning = false, panStart = null;
    var autoFitPending = false; // true from buildModel until the first settle-fit; user pan/zoom cancels it
    // Unified pointer gesture state (one active pointer at a time). A gesture is
    // classified on pointerdown as 'node' (press started on a node) or 'pan' (empty
    // space); a tap that never crosses DRAG_THRESH opens/closes the panel instead of
    // dragging. Deriving tap-vs-drag ourselves — rather than the synthetic click
    // event — is immune to pointer-capture click retargeting, which made node clicks
    // open the panel only intermittently.
    var activePointer = null, gestureMode = null, downX = 0, downY = 0, moved = false;
    var DRAG_THRESH = 4; // px in screen space before a press counts as a drag

    function w(){ return svg.clientWidth || 800; }
    function h(){ return svg.clientHeight || 600; }
    function applyTransform(){
      gViewport.setAttribute('transform', 'translate(' + view.x + ',' + view.y + ') scale(' + view.k + ')');
    }

    // ---------- Build model from API payload ----------
    function buildModel(data){
      stopSim();
      gHalos.textContent = ''; gEdges.textContent = ''; gNodes.textContent = '';
      nodes = []; edges = []; nodeById = {};
      hidePanel();
      var raw = (data && data.nodes) || [];
      var rawEdges = (data && data.edges) || [];
      var cx = w() / 2, cy = h() / 2, n = raw.length;
      raw.forEach(function(nd, i){
        var ang = (2 * Math.PI * i) / Math.max(1, n);
        var node = {
          id: nd.id, title: nd.title || nd.id, type: nd.type || null,
          degree: nd.degree || 0, confidence: (nd.confidence === undefined ? null : nd.confidence),
          updatedAt: nd.updatedAt || null, stale: !!nd.stale, contradiction: !!nd.contradiction,
          excerpt: nd.excerpt || null,
          x: cx + Math.cos(ang) * 180 + (Math.random() * 20 - 10),
          y: cy + Math.sin(ang) * 180 + (Math.random() * 20 - 10),
          vx: 0, vy: 0, neighbors: {}
        };
        nodes.push(node); nodeById[node.id] = node;
      });
      rawEdges.forEach(function(e){
        var s = nodeById[e.source], t = nodeById[e.target];
        if (!s || !t) return;
        edges.push({ source: s, target: t });
        s.neighbors[t.id] = true; t.neighbors[s.id] = true;
      });
      // Adapt the physics to the graph size: more nodes need stronger mutual
      // repulsion (and a few more settle ticks) so clusters separate instead of
      // collapsing into one hairball. Small graphs keep the airy hand-tuned look.
      var spread = Math.max(1, Math.sqrt(n / 30));
      REPULSE = 4200 * spread;
      PRESOLVE_TICKS = n > 120 ? 340 : 220;
      // Declutter: hide labels by default past a threshold; hover/search reveals them.
      gNodes.classList.toggle('declutter', n > LABEL_LIMIT);
      createEls();
      view = { x: 0, y: 0, k: 1 }; applyTransform();
      // Only run the simulation when there is something to lay out — an empty
      // graph would otherwise spin ~260 idle RAF frames before self-terminating.
      // Pre-solve off-screen first so the view opens on an already-settled layout,
      // then auto-fit the whole graph into the viewport (large graphs would else
      // spill off-screen), and a low alpha lets it ease gently into place.
      autoFitPending = true;
      if (nodes.length) { presolve(); fitView(); alpha = 0.35; startSim(); }
      // Re-apply an active search filter to the freshly-built node set (refresh/toggle).
      if (elSearch && elSearch.value.trim()) runSearch(); else clearSearch();
    }

    function createEls(){
      edges.forEach(function(e){
        var p = document.createElementNS(SVGNS, 'path');
        p.setAttribute('class', 'kb-edge');
        e.el = p; gEdges.appendChild(p);
      });
      nodes.forEach(function(node){
        // sqrt keeps hub nodes prominent without dwarfing the rest (linear grew too fast).
        var r = Math.min(24, 5 + Math.sqrt(node.degree) * 5);
        node.r = r;
        // Blurred colour halo in the #kb-halos layer → soft bloom behind the crisp node.
        var halo = document.createElementNS(SVGNS, 'circle');
        halo.setAttribute('r', r * 1.9);
        halo.setAttribute('fill', colorFor(node.type));
        halo.setAttribute('opacity', node.stale ? '0.18' : '0.5');
        node.halo = halo; gHalos.appendChild(halo);

        var g = document.createElementNS(SVGNS, 'g');
        g.setAttribute('class', 'kb-node' + (node.stale ? ' stale' : '') + (node.contradiction ? ' contradiction' : ''));
        var c = document.createElementNS(SVGNS, 'circle');
        c.setAttribute('r', r);
        c.setAttribute('fill', colorFor(node.type));
        var label = document.createElementNS(SVGNS, 'text');
        label.setAttribute('x', r + 4); label.setAttribute('y', 4);
        label.textContent = node.title;
        g.appendChild(c); g.appendChild(label);
        node.el = g;
        g.__node = node; // DOM -> model back-reference for hit-testing in the pointer model
        // Hover highlight only — press/drag/tap are handled by the unified pointer
        // model on the SVG (a captured gesture routes pointer events to the SVG, so
        // per-node handlers would fire inconsistently and fight the pan/drag logic).
        g.addEventListener('pointerenter', function(){ if (activePointer === null) highlight(node); });
        g.addEventListener('pointerleave', function(){ if (activePointer === null) clearHighlight(); });
        gNodes.appendChild(g);
      });
    }

    // ---------- Force simulation ----------
    // One integration step (no paint): repulsion (all pairs) + spring (edges) + centering.
    function simStep(){
      var i, j, a, b, dx, dy, d2, d, f, ux, uy;
      for (i = 0; i < nodes.length; i++){ nodes[i].fx = 0; nodes[i].fy = 0; }
      for (i = 0; i < nodes.length; i++){
        for (j = i + 1; j < nodes.length; j++){
          a = nodes[i]; b = nodes[j];
          dx = a.x - b.x; dy = a.y - b.y; d2 = dx*dx + dy*dy + 0.01; d = Math.sqrt(d2);
          f = REPULSE / d2; ux = dx / d; uy = dy / d;
          a.fx += f*ux; a.fy += f*uy; b.fx -= f*ux; b.fy -= f*uy;
        }
      }
      for (i = 0; i < edges.length; i++){
        a = edges[i].source; b = edges[i].target;
        dx = b.x - a.x; dy = b.y - a.y; d = Math.sqrt(dx*dx + dy*dy) + 0.01;
        f = SPRING_K * (d - REST); ux = dx / d; uy = dy / d;
        a.fx += f*ux; a.fy += f*uy; b.fx -= f*ux; b.fy -= f*uy;
      }
      var cx = w() / 2, cy = h() / 2;
      for (i = 0; i < nodes.length; i++){
        a = nodes[i];
        a.fx += (cx - a.x) * CENTER; a.fy += (cy - a.y) * CENTER;
        if (a === dragNode) continue;
        a.vx = (a.vx + a.fx) * DAMPING; a.vy = (a.vy + a.fy) * DAMPING;
        if (a.vx > VMAX) a.vx = VMAX; else if (a.vx < -VMAX) a.vx = -VMAX;
        if (a.vy > VMAX) a.vy = VMAX; else if (a.vy < -VMAX) a.vy = -VMAX;
        a.x += a.vx; a.y += a.vy;
      }
    }
    // Settle the layout off-screen before the first paint (kills the "bouncy" intro).
    function presolve(){ for (var s = 0; s < PRESOLVE_TICKS; s++) simStep(); render(); }
    // Zoom/pan the viewport so the whole settled graph fits with a margin. Essential
    // at scale — a 300-node layout is far larger than the viewport at k=1.
    function fitView(){
      if (!nodes.length) return;
      var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (var i = 0; i < nodes.length; i++){
        var n = nodes[i];
        if (n.x < minX) minX = n.x; if (n.y < minY) minY = n.y;
        if (n.x > maxX) maxX = n.x; if (n.y > maxY) maxY = n.y;
      }
      var pad = 50, gw = (maxX - minX) || 1, gh = (maxY - minY) || 1;
      var k = Math.min((w() - pad * 2) / gw, (h() - pad * 2) / gh, 1.5);
      if (!isFinite(k) || k <= 0) k = 1;
      view.k = k;
      view.x = (w() - k * (minX + maxX)) / 2;
      view.y = (h() - k * (minY + maxY)) / 2;
      applyTransform();
    }
    function tick(){
      simStep();
      render();
      alpha *= 0.985;
      // Re-fit once the layout has settled so post-presolve easing can't leave a
      // large graph drifted partly off-screen. (User pan/zoom after this is kept.)
      if (alpha > 0.02) raf = requestAnimationFrame(tick);
      else { raf = null; if (autoFitPending && nodes.length > LABEL_LIMIT) fitView(); autoFitPending = false; }
    }
    function startSim(){ if (!raf) raf = requestAnimationFrame(tick); }
    function stopSim(){ if (raf){ cancelAnimationFrame(raf); raf = null; } }
    function reheat(){ alpha = Math.max(alpha, 0.5); startSim(); }

    // Curved link: a quadratic bézier bowed perpendicular to the chord (organic, un-tangled).
    function edgePath(e){
      var s = e.source, t = e.target;
      var dx = t.x - s.x, dy = t.y - s.y;
      var len = Math.sqrt(dx*dx + dy*dy) || 1;
      var off = 0.12 * len;
      var mx = (s.x + t.x) / 2 + (-dy / len) * off;
      var my = (s.y + t.y) / 2 + (dx / len) * off;
      return 'M' + s.x + ' ' + s.y + ' Q' + mx + ' ' + my + ' ' + t.x + ' ' + t.y;
    }
    function render(){
      for (var i = 0; i < edges.length; i++){ edges[i].el.setAttribute('d', edgePath(edges[i])); }
      for (var k = 0; k < nodes.length; k++){
        var nd = nodes[k];
        nd.el.setAttribute('transform', 'translate(' + nd.x + ',' + nd.y + ')');
        nd.halo.setAttribute('cx', nd.x); nd.halo.setAttribute('cy', nd.y);
      }
    }

    // ---------- Interactions ----------
    function evtGraphPoint(ev){
      var rect = svg.getBoundingClientRect();
      return {
        x: (ev.clientX - rect.left - view.x) / view.k,
        y: (ev.clientY - rect.top - view.y) / view.k
      };
    }
    // Resolve the node whose element (or a child of it) is under an event, if any.
    function nodeFromEvent(ev){
      var t = ev.target;
      var g = t && t.closest ? t.closest('.kb-node') : null;
      return (g && g.__node) ? g.__node : null;
    }
    // ---- Unified pointer model: one capture drives pan, node-drag, and tap ----
    svg.addEventListener('pointerdown', function(ev){
      if (activePointer !== null) return; // ignore secondary pointers (e.g. 2nd finger)
      autoFitPending = false; // user is interacting — don't stomp their view on settle
      activePointer = ev.pointerId;
      try { svg.setPointerCapture(ev.pointerId); } catch (e) {}
      downX = ev.clientX; downY = ev.clientY; moved = false;
      var node = nodeFromEvent(ev);
      if (node){
        gestureMode = 'node'; dragNode = node;
      } else {
        gestureMode = 'pan'; panning = true; svg.classList.add('panning');
        panStart = { x: ev.clientX - view.x, y: ev.clientY - view.y };
      }
    });
    svg.addEventListener('pointermove', function(ev){
      if (ev.pointerId !== activePointer) return;
      if (!moved){
        var ddx = ev.clientX - downX, ddy = ev.clientY - downY;
        if (ddx * ddx + ddy * ddy > DRAG_THRESH * DRAG_THRESH) moved = true;
      }
      if (gestureMode === 'pan'){
        view.x = ev.clientX - panStart.x; view.y = ev.clientY - panStart.y; applyTransform();
      } else if (gestureMode === 'node' && moved && dragNode){
        var p = evtGraphPoint(ev); dragNode.x = p.x; dragNode.y = p.y; render(); reheat();
      }
    });
    function endGesture(ev, cancelled){
      if (ev.pointerId !== activePointer) return;
      try { svg.releasePointerCapture(ev.pointerId); } catch (e) {}
      // A press that never became a drag is a tap: on a node -> open its panel;
      // on empty space -> dismiss the panel. Deterministic (no reliance on click).
      if (!cancelled && !moved){
        if (gestureMode === 'node' && dragNode) showPanel(dragNode);
        else if (gestureMode === 'pan') hidePanel();
      }
      activePointer = null; gestureMode = null; dragNode = null;
      panning = false; svg.classList.remove('panning');
    }
    svg.addEventListener('pointerup', function(ev){ endGesture(ev, false); });
    svg.addEventListener('pointercancel', function(ev){ endGesture(ev, true); });
    svg.addEventListener('wheel', function(ev){
      ev.preventDefault();
      autoFitPending = false; // user zoomed — keep their view on settle
      var rect = svg.getBoundingClientRect();
      var mx = ev.clientX - rect.left, my = ev.clientY - rect.top;
      var factor = ev.deltaY < 0 ? 1.1 : 1 / 1.1;
      var nk = Math.min(3, Math.max(0.2, view.k * factor));
      view.x = mx - (mx - view.x) * (nk / view.k);
      view.y = my - (my - view.y) * (nk / view.k);
      view.k = nk; applyTransform();
    }, { passive: false });

    function highlight(node){
      for (var i = 0; i < nodes.length; i++){
        var nd = nodes[i];
        var on = (nd === node) || node.neighbors[nd.id];
        nd.el.classList.toggle('dim', !on);
        nd.el.classList.toggle('focus', on); // reveals label while decluttered
        nd.halo.classList.toggle('dim', !on);
      }
      for (var j = 0; j < edges.length; j++){
        var e = edges[j];
        var touch = (e.source === node || e.target === node);
        e.el.classList.toggle('hl', touch);
        e.el.classList.toggle('dim', !touch);
      }
    }
    function clearHighlight(){
      nodes.forEach(function(nd){ nd.el.classList.remove('dim', 'focus'); nd.halo.classList.remove('dim'); });
      edges.forEach(function(e){ e.el.classList.remove('hl'); e.el.classList.remove('dim'); });
    }

    // ---------- Search ----------
    // Filter nodes by title/type/excerpt. Uses its own 'search-*' classes so it never
    // fights the hover highlight ('dim'/'hl'). Empty query restores the full graph.
    function clearSearch(){
      nodes.forEach(function(nd){ nd.el.classList.remove('search-dim', 'search-hit'); nd.halo.classList.remove('search-dim'); });
      edges.forEach(function(e){ e.el.classList.remove('search-dim'); });
      if (elSearchCount) elSearchCount.textContent = '';
    }
    function runSearch(){
      if (!elSearch) return;
      var q = elSearch.value.trim().toLowerCase();
      if (!q){ clearSearch(); return; }
      var hits = [];
      nodes.forEach(function(nd){
        var hay = (nd.title + ' ' + (nd.type || '') + ' ' + (nd.excerpt || '')).toLowerCase();
        var on = hay.indexOf(q) >= 0;
        nd.match = on;
        if (on) hits.push(nd);
        nd.el.classList.toggle('search-hit', on);
        nd.el.classList.toggle('search-dim', !on);
        nd.halo.classList.toggle('search-dim', !on);
      });
      // An edge stays lit only when BOTH ends match, so the highlighted set reads as a subgraph.
      edges.forEach(function(e){ e.el.classList.toggle('search-dim', !(e.source.match && e.target.match)); });
      if (elSearchCount) elSearchCount.textContent = hits.length + ' / ' + nodes.length;
      return hits;
    }
    // Enter → recentre the view on the first match so it is easy to find in a big graph.
    function focusFirstMatch(){
      var hits = runSearch();
      if (!hits || !hits.length) return;
      var n0 = hits[0];
      view.k = Math.max(view.k, 1);
      view.x = w() / 2 - n0.x * view.k;
      view.y = h() / 2 - n0.y * view.k;
      applyTransform();
    }

    function el(tag, txt){ var e = document.createElement(tag); if (txt !== undefined) e.textContent = txt; return e; }
    function showPanel(node){
      elPanel.textContent = '';
      var close = el('span', '✕'); close.setAttribute('class', 'kb-panel-close');
      close.addEventListener('click', hidePanel);
      elPanel.appendChild(close);
      elPanel.appendChild(el('h3', node.title));
      var dl = document.createElement('dl');
      function row(k, v){ dl.appendChild(el('dt', k)); dl.appendChild(el('dd', v)); }
      row('id', node.id);
      row('type', node.type || '—');
      row('links (degree)', String(node.degree));
      row('confidence', node.confidence === null ? '—' : String(node.confidence));
      row('updated', node.updatedAt || '—');
      if (node.stale) row('status', 'stale (≥ 90d)');
      if (node.contradiction) row('flag', 'in a contradiction');
      elPanel.appendChild(dl);
      // Readable note body preview — the "open and read" part of the panel.
      if (node.excerpt){
        var h = el('div'); h.setAttribute('class', 'kb-panel-note-h'); h.textContent = 'note';
        var body = el('div', node.excerpt); body.setAttribute('class', 'kb-panel-note');
        elPanel.appendChild(h); elPanel.appendChild(body);
      }
      elPanel.style.display = '';
    }
    function hidePanel(){ elPanel.style.display = 'none'; }

    // ---------- Legend + stats ----------
    function renderLegend(){
      elLegend.textContent = '';
      var present = {};
      nodes.forEach(function(nd){ present[nd.type || 'other'] = true; });
      Object.keys(present).forEach(function(type){
        var s = el('span');
        var dot = el('i'); dot.style.background = colorFor(type === 'other' ? null : type);
        s.appendChild(dot); s.appendChild(el('span', type));
        elLegend.appendChild(s);
      });
    }

    // ---------- Load ----------
    function currentScope(){ return (sourceSel && sourceSel.value) || 'shared'; }
    // Demo controls (toggle/size/badge) only make sense for the Shared KB — an
    // agent's own memory has no synthetic demo. Hide them when an agent is picked.
    function syncSourceControls(){
      var isShared = currentScope() === 'shared';
      if (demoToggleWrap) demoToggleWrap.style.display = isShared ? '' : 'none';
      if (demoSizeWrap) demoSizeWrap.style.display = (isShared && demoToggle.checked) ? '' : 'none';
      if (!isShared) elDemoBadge.style.display = 'none';
    }

    // Populate the source selector from /knowledge/sources (Shared KB + agents that
    // have Lane-2 memory notes), preserving the current selection, then load.
    function loadSources(){
      fetch(apiUrl('/knowledge/sources'), { headers: { 'Accept': 'application/json' } }).then(function(res){
        if (res.status === 401) { onUnauthorized(); return null; }
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      }).then(function(data){
        if (!data || !sourceSel) { loadGraph(); return; }
        var prev = sourceSel.value || 'shared';
        sourceSel.textContent = '';
        (data.sources || [{ id: 'shared', label: 'Shared KB', count: 0 }]).forEach(function(s){
          var o = document.createElement('option');
          o.value = s.id; o.textContent = s.label + (typeof s.count === 'number' ? ' (' + s.count + ')' : '');
          sourceSel.appendChild(o);
        });
        // Restore prior selection if it still exists, else fall back to Shared KB.
        sourceSel.value = prev;
        if (sourceSel.value !== prev) sourceSel.value = 'shared';
        loadGraph();
      }).catch(function(){ loadGraph(); }); // selector best-effort — the graph still loads
    }

    function loadGraph(){
      syncSourceControls();
      var scope = currentScope();
      var q = '';
      if (scope !== 'shared') {
        q = '?scope=' + encodeURIComponent(scope);
      } else if (!demoToggle.checked) {
        q = '?demo=off';
      } else if (demoSize && demoSize.value !== '0') {
        q = '?demo=' + encodeURIComponent(demoSize.value);
      }
      var url = apiUrl('/knowledge/graph') + q;
      elStats.textContent = 'Loading…'; elEmpty.style.display = 'none';
      fetch(url, { headers: { 'Accept': 'application/json' } }).then(function(res){
        if (res.status === 401) { onUnauthorized(); return null; }
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      }).then(function(data){
        if (!data) return;
        var isDemo = !!data.demo;
        elDemoBadge.style.display = isDemo ? '' : 'none';
        if (!data.nodes || data.nodes.length === 0){
          buildModel({ nodes: [], edges: [] });
          elStats.textContent = '';
          elEmpty.textContent = scope === 'shared'
            ? 'No notes in the shared Knowledge Base yet. Notes appear here once agents promote memories to the shared vault (dreaming auto mode), or enable the demo toggle above.'
            : 'This agent has no memory notes yet.';
          elEmpty.style.display = '';
          elLegend.textContent = '';
          return;
        }
        buildModel(data);
        renderLegend();
        elStats.textContent = data.nodes.length + ' notes, ' + data.edges.length + ' links';
      }).catch(function(err){
        elStats.textContent = ''; elEmpty.textContent = 'Failed to load graph: ' + err.message; elEmpty.style.display = '';
      });
    }

    document.getElementById('kb-refresh').addEventListener('click', loadGraph);
    if (sourceSel) sourceSel.addEventListener('change', loadGraph);
    demoToggle.addEventListener('change', loadGraph);
    if (demoSize) demoSize.addEventListener('change', loadGraph);
    if (elSearch){
      elSearch.addEventListener('input', runSearch);
      elSearch.addEventListener('keydown', function(ev){
        if (ev.key === 'Enter') focusFirstMatch();
        else if (ev.key === 'Escape') { elSearch.value = ''; clearSearch(); }
      });
    }
  })();
  </script>

  <script id="kb-dreams">
    // Nightly dreaming report renderer. Fetches /knowledge/dreams (parsed audit
    // trail across all agents), renders a newest-first timeline with per-run
    // proposals, and an agent filter. All text goes through textContent (no HTML
    // injection). Uses the global apiUrl/onUnauthorized helpers.
    (function(){
      var listEl = document.getElementById('dreams-list');
      var emptyEl = document.getElementById('dreams-empty');
      var statsEl = document.getElementById('dreams-stats');
      var agentSel = document.getElementById('dreams-agent');
      var refreshBtn = document.getElementById('dreams-refresh');
      var allRuns = [];
      var loaded = false;

      function el(tag, cls, text){
        var e = document.createElement(tag);
        if (cls) e.className = cls;
        if (text != null) e.textContent = text;
        return e;
      }

      function renderRun(run){
        var box = el('div', 'dream-run');
        var head = el('div', 'dream-run-head');
        if (run.agent) head.appendChild(el('span', 'agent', run.agent));
        var modeCls = run.mode === 'auto' ? 'auto' : 'propose';
        head.appendChild(el('span', 'dream-badge ' + modeCls, run.mode));
        head.appendChild(el('span', 'dream-badge outcome', run.outcome));
        head.appendChild(el('span', 'when', run.iso));
        box.appendChild(head);

        if (run.summary) box.appendChild(el('div', 'dream-summary', run.summary));

        if (run.proposals && run.proposals.length){
          var props = el('div', 'dream-props');
          run.proposals.forEach(function(p){
            var pe = el('div', 'dream-prop');
            var top = el('div');
            top.appendChild(el('span', 'op ' + (p.op || ''), p.op || '?'));
            top.appendChild(el('span', 'file', p.file || ''));
            top.appendChild(el('span', 'score', 'score ' + (p.score != null ? p.score : '?') + ' · recall ' + (p.recallCount != null ? p.recallCount : '?')));
            pe.appendChild(top);
            if (p.reason) pe.appendChild(el('div', 'reason', p.reason));
            if (p.content) pe.appendChild(el('div', 'content', p.content));
            props.appendChild(pe);
          });
          box.appendChild(props);
        }

        var applied = (run.applied != null) ? (', applied ' + run.applied) : '';
        box.appendChild(el('div', 'dream-meta', 'tokens ' + (run.tokens||0) + ' · sessions ' + (run.sessions||0) + applied));
        return box;
      }

      function render(){
        var filter = agentSel ? agentSel.value : '';
        var runs = filter ? allRuns.filter(function(r){ return r.agent === filter; }) : allRuns;
        listEl.textContent = '';
        if (!runs.length){
          emptyEl.textContent = allRuns.length ? 'No dream runs for this agent.' : 'No dream runs yet. The nightly dreaming pass writes here after it first runs (auto or propose mode).';
          emptyEl.style.display = '';
          statsEl.textContent = '';
          return;
        }
        emptyEl.style.display = 'none';
        statsEl.textContent = runs.length + ' run' + (runs.length === 1 ? '' : 's');
        runs.forEach(function(r){ listEl.appendChild(renderRun(r)); });
      }

      function loadDreams(force){
        if (loaded && !force) return;
        loaded = true;
        statsEl.textContent = 'Loading…';
        fetch(apiUrl('/knowledge/dreams'), { headers: { 'Accept': 'application/json' } }).then(function(res){
          if (res.status === 401) { onUnauthorized(); return null; }
          if (!res.ok) throw new Error('HTTP ' + res.status);
          return res.json();
        }).then(function(data){
          if (!data) return;
          allRuns = data.runs || [];
          // Populate the agent filter, preserving the current pick.
          if (agentSel){
            var prev = agentSel.value;
            agentSel.textContent = '';
            agentSel.appendChild(el('option', null, 'All agents')); agentSel.lastChild.value = '';
            (data.agents || []).forEach(function(a){ var o = el('option', null, a); o.value = a; agentSel.appendChild(o); });
            agentSel.value = prev; if (agentSel.value !== prev) agentSel.value = '';
          }
          render();
        }).catch(function(err){
          statsEl.textContent = ''; emptyEl.textContent = 'Failed to load dreams: ' + err.message; emptyEl.style.display = '';
        });
      }

      if (agentSel) agentSel.addEventListener('change', render);
      if (refreshBtn) refreshBtn.addEventListener('click', function(){ loadDreams(true); });
      // Exposed so the tab switcher (in the kb-graph script) can lazy-load on first open.
      window.__loadDreams = loadDreams;
    })();
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
export function generateLoginHtml(disabledReason = ''): string {
  const safeReason = disabledReason
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  // When a disabled reason is supplied (keyless install on a non-loopback bind),
  // render a notice instead of the login form — there is no key to log in with.
  const bodyInner = safeReason
    ? `    <h1>Claude Gateway</h1>
    <div class="sub">${safeReason}</div>`
    : `    <h1>Claude Gateway</h1>
    <div class="sub">Enter an API key to access the dashboard.</div>
    <form id="login-form" autocomplete="off">
      <label for="key">API key</label>
      <input id="key" type="password" placeholder="sk-gateway-..." autofocus>
      <button type="submit">Sign in</button>
      <div id="err"></div>
    </form>`;
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
${bodyInner}
  </div>
  <script>
    function basePath() {
      var p = window.location.pathname;
      if (p.endsWith('/dashboard')) return p.slice(0, -10);
      if (p.endsWith('/dashboard/')) return p.slice(0, -11);
      return p.endsWith('/') ? p.slice(0, -1) : p;
    }
    var loginForm = document.getElementById('login-form');
    if (loginForm) loginForm.addEventListener('submit', async function(e) {
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
