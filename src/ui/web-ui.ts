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
    /* Top-right cluster: the Logout button sits beside the auto-refresh status. */
    #top-right { float: right; display: inline-flex; align-items: center; gap: 10px; }
    #refresh-indicator { font-size: 0.75rem; color: #4a5568; }
    #logout-btn {
      font-size: 0.7rem; background: #2d3748; color: #a0aec0; border: 1px solid #4a5568;
      border-radius: 4px; padding: 2px 8px; cursor: pointer;
    }
    #logout-btn:hover { background: #374151; }
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
      #top-right { float: none; display: flex; margin-top: 4px; }
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
    #kb-demo-size, #kb-source, #dreams-agent {
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
    /* The graph is a 3D sphere rendered on <canvas> (auto-spins; drag rotates the view;
       always centred by projection). Node/edge/label styling lives in the canvas paint
       code, not CSS. */
    #kb-canvas { width: 100%; height: 100%; display: block; cursor: grab; touch-action: none; }
    #kb-canvas.drag { cursor: grabbing; }
    /* Zoom controls, pinned bottom-right of the graph stage. */
    .kb-zoom {
      position: absolute; right: 12px; bottom: 12px; display: flex; flex-direction: column;
      gap: 6px; z-index: 3;
    }
    .kb-zoom button {
      width: 32px; height: 32px; padding: 0; font-size: 1.15rem; line-height: 1;
      display: flex; align-items: center; justify-content: center;
      background: rgba(26, 35, 51, 0.82); color: #e2e8f0; border: 1px solid #2d3748;
      border-radius: 6px; cursor: pointer; backdrop-filter: blur(3px); user-select: none;
    }
    .kb-zoom button:hover { background: rgba(45, 55, 72, 0.92); border-color: #4a5568; }
    .kb-zoom button:active { background: #374151; }
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
    .dream-prop .anchor { color: #f6ad55; font-family: monospace; font-size: 0.72rem; margin-top: 3px; }
    .dream-prop.accepted { border-color: #2f855a; }
    .dream-prop-actions { display: flex; align-items: center; gap: 8px; margin-top: 6px; }
    .dream-accept-btn { background: #22543d; color: #9ae6b4; border: 1px solid #2f855a; border-radius: 4px;
      padding: 2px 10px; font-size: 0.74rem; font-weight: 600; cursor: pointer; }
    .dream-accept-btn:hover { background: #276749; }
    .dream-accept-btn:disabled { opacity: 0.55; cursor: default; }
    .prop-status { font-size: 0.72rem; font-weight: 600; }
    .prop-status.applied { color: #9ae6b4; }
    .prop-status.applied-auto { color: #68d391; }
    .prop-status.pending { color: #90cdf4; }
    .prop-status.failed { color: #fc8181; }
    .dream-accept-all { background: #22543d; color: #9ae6b4; border: 1px solid #2f855a; border-radius: 4px;
      padding: 1px 9px; font-size: 0.7rem; font-weight: 600; cursor: pointer; }
    .dream-accept-all:hover { background: #276749; }
    .dream-accept-all:disabled { opacity: 0.55; cursor: default; }
    /* Note detail — full-width card below the graph. Shows the whole file. */
    .kb-note {
      margin-top: 12px; background: #131a2b; border: 1px solid #2d3748; border-radius: 8px;
      padding: 16px 18px; font-size: 0.85rem; color: #cbd5e0;
    }
    .kb-note-head { display: flex; align-items: flex-start; gap: 10px; }
    .kb-note-head h3 { margin: 0; font-size: 1.02rem; color: #e2e8f0; flex: 1; word-break: break-word; }
    .kb-note-close {
      cursor: pointer; color: #718096; background: #1a202c; border: 1px solid #2d3748;
      border-radius: 4px; padding: 1px 8px; font-size: 0.9rem; line-height: 1.4;
    }
    .kb-note-close:hover { color: #e2e8f0; background: #2d3748; }
    /* Metadata chips row. */
    .kb-note-meta { display: flex; flex-wrap: wrap; gap: 6px; margin: 10px 0 4px; }
    .kb-note-chip {
      display: inline-flex; align-items: center; gap: 5px; background: #0e1420;
      border: 1px solid #1e2740; border-radius: 999px; padding: 2px 10px; font-size: 0.72rem; color: #a0aec0;
    }
    .kb-note-chip b { color: #cbd5e0; font-weight: 600; }
    .kb-note-chip i { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }
    /* File path line under the chips — full width, monospace, wraps on long paths. */
    .kb-note-path {
      margin: 6px 0 2px; font-size: 0.72rem; font-family: ui-monospace, monospace;
      color: #718096; word-break: break-all;
    }
    .kb-note-path b { color: #a0aec0; font-weight: 600; }
    /* Rendered Markdown body. */
    .kb-md {
      margin-top: 12px; padding-top: 12px; border-top: 1px solid #222c40;
      line-height: 1.62; color: #cbd5e0; word-break: break-word;
    }
    .kb-md > :first-child { margin-top: 0; }
    .kb-md h1, .kb-md h2, .kb-md h3, .kb-md h4 { color: #e2e8f0; line-height: 1.3; margin: 18px 0 8px; }
    .kb-md h1 { font-size: 1.25rem; border-bottom: 1px solid #222c40; padding-bottom: 5px; }
    .kb-md h2 { font-size: 1.1rem; border-bottom: 1px solid #1e2740; padding-bottom: 4px; }
    .kb-md h3 { font-size: 1rem; } .kb-md h4 { font-size: 0.9rem; color: #a0aec0; }
    .kb-md p { margin: 8px 0; }
    .kb-md ul, .kb-md ol { margin: 8px 0; padding-left: 22px; }
    .kb-md li { margin: 3px 0; }
    .kb-md a { color: #63b3ed; text-decoration: none; } .kb-md a:hover { text-decoration: underline; }
    .kb-md code {
      background: #0d1117; border: 1px solid #1e2740; border-radius: 4px;
      padding: 1px 5px; font-size: 0.82em; font-family: ui-monospace, monospace; color: #e2e8f0;
    }
    .kb-md pre {
      background: #0a0e17; border: 1px solid #1e2740; border-radius: 6px; padding: 10px 12px;
      overflow-x: auto; margin: 10px 0;
    }
    .kb-md pre code { background: none; border: none; padding: 0; font-size: 0.8rem; line-height: 1.5; }
    .kb-md blockquote {
      margin: 10px 0; padding: 2px 14px; border-left: 3px solid #2d3748; color: #a0aec0;
    }
    .kb-md hr { border: none; border-top: 1px solid #222c40; margin: 14px 0; }
    .kb-md strong { color: #e2e8f0; } .kb-md table { border-collapse: collapse; margin: 0; width: 100%; font-size: 0.82rem; }
    .kb-md th, .kb-md td { border: 1px solid #222c40; padding: 5px 10px; text-align: left; }
    .kb-md th { background: #0e1420; color: #e2e8f0; font-weight: 600; }
    .kb-md tbody tr:nth-child(even) { background: #0e1420; }
    /* Wide tables scroll horizontally instead of breaking the panel. */
    .kb-table-wrap { overflow-x: auto; margin: 10px 0; border-radius: 6px; }
    .kb-md del { color: #718096; }
    /* Task-list items: bullet replaced by a real (disabled) checkbox. */
    .kb-md li.kb-task { list-style: none; margin-left: -18px; }
    .kb-md li.kb-task input { margin-right: 7px; vertical-align: middle; accent-color: #63b3ed; }
    .kb-note-loading { color: #718096; font-size: 0.82rem; margin-top: 12px; }
  </style>
</head>
<body>
  <h1><span class="rainbow">Claude Gateway</span> <span id="gateway-version" style="font-size:0.75rem;color:#718096;"></span> <span id="top-right"><button id="logout-btn">Logout</button><span id="refresh-indicator">refreshing...</span></span></h1>
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

  <!-- Knowledge base — a 3D force-directed graph over the shared vault / an agent's memory.
       Zero external deps: the spherical layout + canvas render + rotation are hand-rolled. -->
  <div id="view-kb" class="view" style="display:none;">
    <div class="kb-toolbar">
      <label id="kb-source-wrap" title="Which memory graph to view: the cross-agent Shared KB, or one agent's own memory">Source
        <select id="kb-source"><option value="shared">Shared Knowledge Base</option></select>
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
          <option value="300" selected>300</option>
          <option value="600">600</option>
        </select>
      </label>
      <span id="kb-demo-badge" class="kb-demo-badge" style="display:none;">DEMO DATA</span>
      <span id="kb-stats"></span>
      <span class="kb-legend" id="kb-legend"></span>
    </div>
    <div class="kb-stage">
      <!-- 3D knowledge graph: a sphere of notes rendered on canvas. Auto-spins; drag
           empty space to rotate the view; wheel to zoom. Centred by projection, so there
           is no pan and no "center" button — the graph can never drift off-screen. -->
      <canvas id="kb-canvas"></canvas>
      <div id="kb-empty" class="kb-empty" style="display:none;"></div>
      <div class="kb-zoom">
        <button id="kb-zoom-in" type="button" title="Zoom in" aria-label="Zoom in">&plus;</button>
        <button id="kb-zoom-out" type="button" title="Zoom out" aria-label="Zoom out">&minus;</button>
      </div>
    </div>
    <!-- Note detail — full width BELOW the graph so the whole file shows (no
         truncation), rendered as formatted Markdown. Populated on node click. -->
    <div id="kb-note" class="kb-note" style="display:none;"></div>
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

    // ---------- Graph elements + refs ----------
    var canvas = document.getElementById('kb-canvas');
    var elEmpty = document.getElementById('kb-empty');
    var elNote = document.getElementById('kb-note');
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

    // Curated colours for the memory type: vocabulary that ACTUALLY appears in
    // notes (user / feedback / project / reference / …) — the old map keyed on a
    // KB ontology (decision/evidence/claim…) that never matched, so every node
    // fell to one grey. Any type not listed gets a stable, distinct hue from a
    // hash so tags never collapse to a single colour again.
    var TYPE_COLORS = {
      user: '#63b3ed', feedback: '#f6ad55', project: '#68d391',
      reference: '#b794f4', session: '#4fd1c5', fact: '#f687b3',
      decision: '#63b3ed', evidence: '#68d391', claim: '#f6ad55',
      policy: '#b794f4', infra: '#4fd1c5'
    };
    var DEFAULT_COLOR = '#7d8fb3';
    function hashHue(s){ var h = 0; for (var i = 0; i < s.length; i++){ h = (h * 31 + s.charCodeAt(i)) & 0xffffffff; } return Math.abs(h) % 360; }
    function colorFor(type){
      if (!type || type === 'other') return DEFAULT_COLOR;
      if (TYPE_COLORS[type]) return TYPE_COLORS[type];
      // Deterministic distinct colour for any unlisted type (mid tone, readable on the dark stage).
      return 'hsl(' + hashHue(type) + ', 62%, 62%)';
    }

    // ---------- 3D graph engine (canvas) ----------
    // Notes are laid out on the surface of a unit sphere (Fibonacci seed + a short 3D
    // force relax) centred at the origin. Every frame the whole sphere is rotated by
    // (rotY, rotX) and perspective-projected to the canvas centre — so the graph is
    // ALWAYS centred by construction: no pan, no "center" button, it cannot drift off
    // screen. It auto-spins; dragging empty space rotates the view. This 3D rotation is
    // the "หมุน" a flat 2D SVG (which could only pan) was never able to do.
    var LABEL_MIN_DEG = 3;      // hubs keep their label; others reveal on hover/search
    var G = null;               // { nodes:[{nd,x,y,z,deg,i,hit}], edges:[{a,b}] }
    var rotY = 0.6, rotX = -0.25, zoom = 1;
    var dragging = false, moved = false, downX = 0, downY = 0, lastX = 0, lastY = 0;
    // Angular momentum: the last drag speed carries the sphere on after release so it
    // keeps orbiting (decays toward the gentle baseline auto-spin) instead of freezing.
    var velY = 0, velX = 0;
    var MIN_ZOOM = 0.25, MAX_ZOOM = 8, SPIN = 0.0025;   // zoom clamp + baseline orbit speed
    var hover = null, selected = null, auto = true;
    var cvW = 0, cvH = 0, cvDpr = 1, needRender = true, lastFrame = 0;
    var P = [];                 // last projected screen coords, for hit-testing

    function invalidate(){ needRender = true; }
    function sizeCanvas(){
      if (!canvas) return;
      cvDpr = window.devicePixelRatio || 1;
      cvW = canvas.clientWidth; cvH = canvas.clientHeight;
      canvas.width = cvW * cvDpr; canvas.height = cvH * cvDpr;
      invalidate();
    }

    // ---------- Build model from API payload ----------
    // Seed nodes on a Fibonacci sphere, then relax with a 3D repulsion + spring pass so
    // linked notes pull together into clusters while the whole set stays on the sphere.
    function buildModel(data){
      hideNote(); hover = null; selected = null;
      var raw = (data && data.nodes) || [];
      var rawEdges = (data && data.edges) || [];
      var N = raw.length || 1;
      var byId = {};
      var nodes = raw.map(function(nd, i){
        var t = Math.acos(1 - 2 * (i + 0.5) / N), p = Math.PI * (1 + Math.sqrt(5)) * i;
        return {
          nd: {
            id: nd.id, title: nd.title || nd.id, type: nd.type || null,
            degree: nd.degree || 0,
            confidence: (nd.confidence === undefined ? null : nd.confidence),
            updatedAt: nd.updatedAt || null, stale: !!nd.stale,
            contradiction: !!nd.contradiction, excerpt: nd.excerpt || null
          },
          x: Math.sin(t) * Math.cos(p), y: Math.sin(t) * Math.sin(p), z: Math.cos(t),
          deg: 0, i: i, hit: true
        };
      });
      nodes.forEach(function(o){ byId[o.nd.id] = o; });
      var edges = [];
      rawEdges.forEach(function(e){
        var a = byId[e.source], b = byId[e.target];
        if (a && b){ edges.push({ a: a, b: b }); a.deg++; b.deg++; }
      });
      relax(nodes, edges);
      G = { nodes: nodes, edges: edges };
      rotY = 0.6; rotX = -0.25; zoom = 1; auto = true; velY = 0; velX = 0;
      sizeCanvas(); invalidate();
      // Re-apply an active search to the freshly-built set (refresh / source switch).
      if (elSearch && elSearch.value.trim()) runSearch(); else clearSearch();
    }

    // Short 3D force relax: all-pairs repulsion keeps nodes apart, edge springs pull
    // linked notes together, then recentre at the origin and renormalise to the unit
    // sphere so projection stays centred. Iterations scale down for large demo sets.
    function relax(nodes, edges){
      var N = nodes.length || 1;
      var iters = N > 400 ? 60 : 110;
      for (var it = 0; it < iters; it++){
        for (var i = 0; i < nodes.length; i++){
          for (var k = i + 1; k < nodes.length; k++){
            var dx = nodes[i].x - nodes[k].x, dy = nodes[i].y - nodes[k].y, dz = nodes[i].z - nodes[k].z;
            var d2 = dx*dx + dy*dy + dz*dz + 0.01, f = 0.018 / d2, inv = 1 / Math.sqrt(d2);
            dx *= inv; dy *= inv; dz *= inv;
            nodes[i].x += dx*f; nodes[i].y += dy*f; nodes[i].z += dz*f;
            nodes[k].x -= dx*f; nodes[k].y -= dy*f; nodes[k].z -= dz*f;
          }
        }
        for (var e = 0; e < edges.length; e++){
          var A = edges[e].a, B = edges[e].b;
          var ex = B.x - A.x, ey = B.y - A.y, ez = B.z - A.z, sf = 0.012;
          A.x += ex*sf; A.y += ey*sf; A.z += ez*sf; B.x -= ex*sf; B.y -= ey*sf; B.z -= ez*sf;
        }
      }
      var cx = 0, cy = 0, cz = 0;
      nodes.forEach(function(n){ cx += n.x; cy += n.y; cz += n.z; });
      cx /= N; cy /= N; cz /= N;
      var R = 0;
      nodes.forEach(function(n){ n.x -= cx; n.y -= cy; n.z -= cz; R = Math.max(R, Math.hypot(n.x, n.y, n.z)); });
      R = R || 1;
      nodes.forEach(function(n){ n.x /= R; n.y /= R; n.z /= R; });
    }

    // ---------- Render ----------
    // Rotate each node by (rotY around the vertical axis, rotX around the horizontal),
    // perspective-divide, and paint. Depth (post-rotation z) drives alpha and paint
    // order so the near hemisphere reads brighter and overpaints the far one.
    function render(){
      if (!canvas || !G || !cvW) return;
      var ctx = canvas.getContext('2d');
      ctx.setTransform(cvDpr, 0, 0, cvDpr, 0, 0);
      ctx.clearRect(0, 0, cvW, cvH);
      var nodes = G.nodes;
      if (!nodes.length){ P = []; return; }
      var cyw = Math.cos(rotY), syw = Math.sin(rotY), cxp = Math.cos(rotX), sxp = Math.sin(rotX);
      var scale = Math.min(cvW, cvH) * 0.34 * zoom, ox = cvW / 2, oy = cvH / 2, cam = 3;
      var searching = !!(elSearch && elSearch.value.trim());
      P = nodes.map(function(o){
        var x = o.x * cyw - o.z * syw, z = o.x * syw + o.z * cyw;
        var y = o.y * cxp - z * sxp; z = o.y * sxp + z * cxp;
        var q = cam / (cam - z);
        return { sx: ox + x * scale * q, sy: oy + y * scale * q, z: z,
                 r: Math.max(2.5, (4 + Math.sqrt(o.deg) * 2.2) * q), o: o };
      });
      // Edges first, depth-shaded (far side dimmer); dimmed hard when searching unless
      // both ends match the query, so the hit set reads as a connected subgraph.
      ctx.lineWidth = 1;
      G.edges.forEach(function(ed){
        var a = P[ed.a.i], b = P[ed.b.i];
        var depth = ((a.z + b.z) / 2 + 1) / 2;
        var lit = !searching || (ed.a.hit && ed.b.hit);
        ctx.strokeStyle = 'rgba(120,150,210,' + (lit ? (0.10 + 0.32 * depth) : 0.03) + ')';
        ctx.beginPath(); ctx.moveTo(a.sx, a.sy); ctx.lineTo(b.sx, b.sy); ctx.stroke();
      });
      // Nodes back-to-front so near nodes overpaint far ones.
      var order = P.map(function(_, i){ return i; }).sort(function(i, k){ return P[i].z - P[k].z; });
      order.forEach(function(i){
        var p = P[i], o = p.o, nd = o.nd, near = (p.z + 1) / 2;
        var isHov = hover === i, isSel = selected === i;
        var dim = searching && !o.hit;
        var alpha = dim ? 0.08 : (0.4 + 0.6 * near);
        var col = colorFor(nd.type); // keep the node's own type colour, even when hovered/selected
        // Soft additive bloom so each node reads as a point of LIGHT (fuzzy halo),
        // not a flat disc with a hard edge. Radial gradient fading to transparent,
        // painted with 'lighter' so overlapping glows accumulate like real light.
        if (!dim){
          var glowR = p.r * ((isHov || isSel) ? 6.5 : 4.2);
          var gi = ((isHov || isSel) ? 0.55 : 0.26) * (0.45 + 0.55 * near);
          var grad = ctx.createRadialGradient(p.sx, p.sy, 0, p.sx, p.sy, glowR);
          grad.addColorStop(0, col);
          grad.addColorStop(1, 'rgba(0,0,0,0)');
          ctx.globalCompositeOperation = 'lighter';
          ctx.globalAlpha = gi;
          ctx.fillStyle = grad;
          ctx.beginPath(); ctx.arc(p.sx, p.sy, glowR, 0, 7); ctx.fill();
          ctx.globalCompositeOperation = 'source-over';
          ctx.globalAlpha = 1;
        }
        // Bright solid core on top of its glow.
        ctx.beginPath(); ctx.arc(p.sx, p.sy, p.r, 0, 7);
        ctx.globalAlpha = alpha;
        ctx.fillStyle = col;
        ctx.fill();
        ctx.globalAlpha = 1;
        if (searching && o.hit){ ctx.strokeStyle = '#f6e05e'; ctx.lineWidth = 2; ctx.stroke(); ctx.lineWidth = 1; }
        else if (nd.contradiction){ ctx.strokeStyle = '#fc8181'; ctx.lineWidth = 2; ctx.stroke(); ctx.lineWidth = 1; }
        else if (nd.stale){ ctx.strokeStyle = '#f0883e'; ctx.lineWidth = 1.2; ctx.stroke(); ctx.lineWidth = 1; }
        // Hover / selection ring: a white halo OUTSIDE the node so the node keeps
        // its own type colour. Selected = bright + thick, hover = softer + thinner.
        if ((isSel || isHov) && !dim){
          ctx.beginPath(); ctx.arc(p.sx, p.sy, p.r + 3, 0, 7);
          ctx.strokeStyle = isSel ? 'rgba(255,255,255,0.95)' : 'rgba(255,255,255,0.5)';
          ctx.lineWidth = isSel ? 2 : 1.4; ctx.stroke(); ctx.lineWidth = 1;
        }
        // Labels: hubs always; hovered / selected / search-hit reveal on demand.
        var showLabel = (o.deg >= LABEL_MIN_DEG) || isHov || isSel || (searching && o.hit);
        if (showLabel && !dim){
          ctx.fillStyle = (isHov || isSel) ? '#e6edf3' : 'rgba(213,222,236,' + (0.25 + 0.6 * near) + ')';
          ctx.font = (isHov || isSel ? '12px ' : '11px ') + 'ui-sans-serif, system-ui, sans-serif';
          ctx.fillText(nd.title, p.sx + p.r + 4, p.sy + 3);
        }
      });
    }

    // ---------- Hit-testing + interactions ----------
    function hitTest(mx, my){
      var best = null, bd = 16;
      for (var i = 0; i < P.length; i++){
        var p = P[i]; var d = Math.hypot(p.sx - mx, p.sy - my);
        if (d < bd && d < p.r + 8){ bd = d; best = i; }
      }
      return best;
    }
    function stopSpin(){ auto = false; }
    function initInteractions(){
      if (!canvas) return;
      sizeCanvas();
      window.addEventListener('resize', sizeCanvas);
      canvas.addEventListener('mousedown', function(e){
        dragging = true; moved = false; downX = lastX = e.clientX; downY = lastY = e.clientY;
        velY = 0; velX = 0;   // grabbing halts any residual momentum
        canvas.classList.add('drag');
      });
      // A press that never crossed the drag threshold is a tap: on a node open its
      // panel, on empty space dismiss it. Bound on window so a drag that leaves the
      // canvas still ends cleanly.
      window.addEventListener('mouseup', function(e){
        if (dragging && !moved && G){
          var r = canvas.getBoundingClientRect();
          var hit = hitTest(e.clientX - r.left, e.clientY - r.top);
          if (hit != null){ selected = hit; showNote(G.nodes[hit].nd); }
          else { selected = null; hideNote(); }
          invalidate();
        }
        // Releasing after a rotate resumes the orbit — the sphere keeps spinning,
        // carried on by the momentum captured during the drag (see the frame loop).
        if (dragging) auto = true;
        dragging = false; canvas.classList.remove('drag');
      });
      canvas.addEventListener('mousemove', function(e){
        var r = canvas.getBoundingClientRect();
        if (dragging){
          // Empty-space drag ROTATES the sphere (X drag → spin, Y drag → tilt); this is
          // the interaction the old flat-SVG pan could never provide.
          if (Math.abs(e.clientX - downX) + Math.abs(e.clientY - downY) > 4){ moved = true; }
          var dY = (e.clientX - lastX) * 0.01, dX = (e.clientY - lastY) * 0.01;
          rotY += dY; rotX += dX;
          velY = dY; velX = dX;   // remember the latest speed → release momentum
          if (rotX > 1.5) rotX = 1.5; else if (rotX < -1.5) rotX = -1.5;
          lastX = e.clientX; lastY = e.clientY; invalidate();
        } else {
          var hit = hitTest(e.clientX - r.left, e.clientY - r.top);
          if (hit !== hover){ hover = hit; canvas.style.cursor = (hit != null) ? 'pointer' : 'grab'; invalidate(); }
        }
      });
      // Touch: one-finger drag rotates.
      canvas.addEventListener('touchstart', function(e){
        if (e.touches.length === 1){ dragging = true; moved = false; velY = 0; velX = 0;
          var t = e.touches[0]; downX = lastX = t.clientX; downY = lastY = t.clientY; }
      }, { passive: true });
      canvas.addEventListener('touchmove', function(e){
        if (dragging && e.touches.length === 1){
          var t = e.touches[0];
          var dY = (t.clientX - lastX) * 0.01, dX = (t.clientY - lastY) * 0.01;
          rotY += dY; rotX += dX; velY = dY; velX = dX;
          if (rotX > 1.5) rotX = 1.5; else if (rotX < -1.5) rotX = -1.5;
          lastX = t.clientX; lastY = t.clientY; moved = true;
          invalidate(); e.preventDefault();
        }
      }, { passive: false });
      canvas.addEventListener('touchend', function(){ if (dragging) auto = true; dragging = false; });
      // Zoom: wheel + the on-screen +/- buttons share one clamp. Range widened so the
      // sphere can be pushed much closer / further than before.
      function zoomBy(f){
        zoom *= f;
        if (zoom < MIN_ZOOM) zoom = MIN_ZOOM; else if (zoom > MAX_ZOOM) zoom = MAX_ZOOM;
        invalidate();
      }
      canvas.addEventListener('wheel', function(e){
        e.preventDefault();
        zoomBy(e.deltaY < 0 ? 1.1 : 0.9);
      }, { passive: false });
      var zin = document.getElementById('kb-zoom-in'), zout = document.getElementById('kb-zoom-out');
      if (zin) zin.addEventListener('click', function(){ zoomBy(1.25); });
      if (zout) zout.addEventListener('click', function(){ zoomBy(0.8); });
      // Single throttled rAF loop: ~30fps, pauses when hidden or nothing changed. Also
      // recovers the canvas size the first time the tab becomes visible (clientWidth is
      // 0 while the view is display:none, so the initial sizeCanvas() reads nothing).
      function frame(t){
        requestAnimationFrame(frame);
        if (document.hidden || !G) return;
        if (!cvW){ sizeCanvas(); if (!cvW) return; }
        if (!dragging && G.nodes.length){
          // Post-release momentum decays smoothly; the baseline auto-spin keeps the
          // sphere orbiting forever once the fling has bled off.
          if (Math.abs(velY) > 0.00008 || Math.abs(velX) > 0.00008){
            rotY += velY; rotX += velX;
            if (rotX > 1.5) rotX = 1.5; else if (rotX < -1.5) rotX = -1.5;
            velY *= 0.95; velX *= 0.95; needRender = true;
          } else { velY = 0; velX = 0; }
          if (auto){ rotY += SPIN; needRender = true; }
        }
        if (!needRender || t - lastFrame < 28) return;
        lastFrame = t; needRender = false; render();
      }
      requestAnimationFrame(frame);
    }

    // ---------- Search ----------
    // Mark matching notes (title / type / excerpt). render() dims the rest and rings the
    // hits; a hit's label is revealed even under the declutter threshold.
    function clearSearch(){
      if (G) G.nodes.forEach(function(o){ o.hit = true; });
      if (elSearchCount) elSearchCount.textContent = '';
      invalidate();
    }
    function runSearch(){
      if (!elSearch || !G) return [];
      var q = elSearch.value.trim().toLowerCase();
      if (!q){ clearSearch(); return []; }
      var hits = [];
      G.nodes.forEach(function(o){
        var nd = o.nd;
        var hay = (nd.title + ' ' + (nd.type || '') + ' ' + (nd.excerpt || '')).toLowerCase();
        o.hit = hay.indexOf(q) >= 0;
        if (o.hit) hits.push(o);
      });
      if (elSearchCount) elSearchCount.textContent = hits.length + ' / ' + G.nodes.length;
      invalidate();
      return hits;
    }
    // Enter → rotate the sphere so the first match faces the camera (front & centre) and
    // open its panel — the 3D analogue of "recentre on the first hit".
    function focusFirstMatch(){
      var hits = runSearch();
      if (!hits.length) return;
      var n0 = hits[0];
      stopSpin(); velY = 0; velX = 0;
      rotY = Math.atan2(n0.x, n0.z);
      var z1 = Math.hypot(n0.x, n0.z);
      rotX = Math.atan2(n0.y, z1);
      if (rotX > 1.5) rotX = 1.5; else if (rotX < -1.5) rotX = -1.5;
      selected = n0.i; showNote(n0.nd);
      invalidate();
    }

    // ---------- Detail note (full-width, below the graph) ----------
    function el(tag, txt){ var e = document.createElement(tag); if (txt !== undefined) e.textContent = txt; return e; }
    function chip(label, value, dotColor){
      var c = el('span'); c.setAttribute('class', 'kb-note-chip');
      if (dotColor){ var i = el('i'); i.style.background = dotColor; c.appendChild(i); }
      c.appendChild(el('span', label + ' ')); c.appendChild(el('b', value));
      return c;
    }

    // ---------- Minimal, XSS-safe Markdown renderer ----------
    // Builds DOM nodes only (textContent everywhere — never assigns raw HTML), so
    // an untrusted note body cannot inject markup. Handles headings, fenced/inline
    // code, lists, blockquotes, hr, and inline bold/italic/code/links.
    // NOTE: this whole script lives inside a TS template literal, so every regex
    // backslash MUST be doubled (\\s not \s) — a single backslash is stripped at
    // build time. Literal backticks are written as \` (kept single).
    function sanitizeHref(h){
      var s = String(h || '').trim();
      // Allow only http(s), mailto, and in-vault relative links; block javascript:, data:, etc.
      if (/^https?:\\/\\//i.test(s) || /^mailto:/i.test(s)) return s;
      if (/^[\\w./#?=&%-]+$/.test(s) && !/^[a-z]+:/i.test(s)) return s;
      return null;
    }
    function renderInline(container, text){
      // Tokenise on: inline code, bold, strikethrough, italic, and [label](href) links.
      var re = /(\`[^\`]+\`)|(\\*\\*[^*]+\\*\\*)|(~~[^~]+~~)|(\\*[^*]+\\*|_[^_]+_)|(\\[[^\\]]+\\]\\([^)]+\\))/;
      var rest = String(text);
      while (rest.length){
        var m = re.exec(rest);
        if (!m){ container.appendChild(document.createTextNode(rest)); break; }
        if (m.index > 0) container.appendChild(document.createTextNode(rest.slice(0, m.index)));
        var tok = m[0];
        if (tok.charAt(0) === '\`'){
          container.appendChild(el('code', tok.slice(1, -1)));
        } else if (tok.slice(0, 2) === '**'){
          container.appendChild(el('strong', tok.slice(2, -2)));
        } else if (tok.slice(0, 2) === '~~'){
          container.appendChild(el('del', tok.slice(2, -2)));
        } else if (tok.charAt(0) === '*' || tok.charAt(0) === '_'){
          container.appendChild(el('em', tok.slice(1, -1)));
        } else {
          var lm = /^\\[([^\\]]+)\\]\\(([^)]+)\\)$/.exec(tok);
          var href = lm ? sanitizeHref(lm[2]) : null;
          if (lm && href){
            var a = el('a', lm[1]); a.setAttribute('href', href);
            a.setAttribute('target', '_blank'); a.setAttribute('rel', 'noopener noreferrer');
            container.appendChild(a);
          } else {
            container.appendChild(document.createTextNode(tok));
          }
        }
        rest = rest.slice(m.index + tok.length);
      }
    }
    function renderMarkdown(root, md){
      root.textContent = '';
      var lines = String(md).replace(/\\r\\n?/g, '\\n').split('\\n');
      var i = 0;
      // Nested-list stack: each entry = { list:<ul|ol>, ordered, indent }.
      var stack = [];
      function endList(){ stack.length = 0; }
      function listTarget(indent, ordered){
        while (stack.length && stack[stack.length - 1].indent > indent) stack.pop();
        var top = stack.length ? stack[stack.length - 1] : null;
        if (top && top.indent === indent){
          if (top.ordered === ordered) return top.list;
          stack.pop(); top = stack.length ? stack[stack.length - 1] : null;
        }
        var listEl = el(ordered ? 'ol' : 'ul');
        if (top && top.indent < indent && top.list.lastChild) top.list.lastChild.appendChild(listEl);
        else root.appendChild(listEl);
        stack.push({ list: listEl, ordered: ordered, indent: indent });
        return listEl;
      }
      // Split a table row into trimmed cells (drop the optional edge pipes).
      function tableCells(row){
        return row.trim().replace(/^\\|/, '').replace(/\\|$/, '').split('|').map(function(s){ return s.trim(); });
      }
      while (i < lines.length){
        var line = lines[i];
        // Fenced code block.
        var fence = /^\\s*\`\`\`(.*)$/.exec(line);
        if (fence){
          endList(); i++;
          var buf = [];
          while (i < lines.length && !/^\\s*\`\`\`\\s*$/.test(lines[i])){ buf.push(lines[i]); i++; }
          i++; // closing fence
          var pre = el('pre'); pre.appendChild(el('code', buf.join('\\n')));
          root.appendChild(pre); continue;
        }
        // Horizontal rule.
        if (/^\\s*([-*_])(\\s*\\1){2,}\\s*$/.test(line)){ endList(); root.appendChild(el('hr')); i++; continue; }
        // Heading.
        var h = /^(#{1,6})\\s+(.*)$/.exec(line);
        if (h){ endList(); var hEl = el('h' + h[1].length); renderInline(hEl, h[2].trim()); root.appendChild(hEl); i++; continue; }
        // Blockquote (collapse consecutive > lines).
        if (/^\\s*>\\s?/.test(line)){
          endList(); var q = el('blockquote'); var qbuf = [];
          while (i < lines.length && /^\\s*>\\s?/.test(lines[i])){ qbuf.push(lines[i].replace(/^\\s*>\\s?/, '')); i++; }
          renderInline(q, qbuf.join(' ')); root.appendChild(q); continue;
        }
        // GFM pipe table: a header row immediately followed by a |---|:--:| separator.
        if (/\\|/.test(line) && i + 1 < lines.length &&
            /^\\s*\\|?\\s*:?-+:?\\s*(\\|\\s*:?-+:?\\s*)*\\|?\\s*$/.test(lines[i + 1])){
          endList();
          var aligns = tableCells(lines[i + 1]).map(function(s){
            var lft = s.charAt(0) === ':', rgt = s.charAt(s.length - 1) === ':';
            return (lft && rgt) ? 'center' : rgt ? 'right' : lft ? 'left' : '';
          });
          var table = el('table'); var thead = el('thead'); var htr = el('tr');
          tableCells(line).forEach(function(c, idx){
            var th = el('th'); if (aligns[idx]) th.style.textAlign = aligns[idx];
            renderInline(th, c); htr.appendChild(th);
          });
          thead.appendChild(htr); table.appendChild(thead);
          var tbody = el('tbody'); i += 2;
          while (i < lines.length && /\\|/.test(lines[i]) && lines[i].trim() !== ''){
            var tr = el('tr');
            tableCells(lines[i]).forEach(function(c, idx){
              var td = el('td'); if (aligns[idx]) td.style.textAlign = aligns[idx];
              renderInline(td, c); tr.appendChild(td);
            });
            tbody.appendChild(tr); i++;
          }
          table.appendChild(tbody);
          var wrap = el('div'); wrap.setAttribute('class', 'kb-table-wrap'); wrap.appendChild(table);
          root.appendChild(wrap); continue;
        }
        // List item (ordered/unordered), indent-nested, with optional task checkbox.
        var li = /^(\\s*)(?:([-*+])|(\\d+)[.)])\\s+(.*)$/.exec(line);
        if (li){
          var indent = li[1].length;
          var ordered = li[3] !== undefined;
          var content = li[4];
          var target = listTarget(indent, ordered);
          var item = el('li');
          var task = /^\\[([ xX])\\]\\s+(.*)$/.exec(content);
          if (task){
            item.setAttribute('class', 'kb-task');
            var box = el('input'); box.setAttribute('type', 'checkbox'); box.setAttribute('disabled', '');
            if (task[1] !== ' ') box.setAttribute('checked', '');
            item.appendChild(box);
            renderInline(item, ' ' + task[2]);
          } else {
            renderInline(item, content);
          }
          target.appendChild(item); i++; continue;
        }
        // Blank line ends a list / paragraph.
        if (/^\\s*$/.test(line)){ endList(); i++; continue; }
        // Paragraph: gather consecutive plain lines.
        endList(); var pbuf = [line];
        i++;
        while (i < lines.length && !/^\\s*$/.test(lines[i]) &&
               !/^(#{1,6})\\s/.test(lines[i]) && !/^\\s*>\\s?/.test(lines[i]) &&
               !/^\\s*(?:[-*+]|\\d+[.)])\\s+/.test(lines[i]) && !/^\\s*\`\`\`/.test(lines[i])){
          pbuf.push(lines[i]); i++;
        }
        var p = el('p'); renderInline(p, pbuf.join('\\n')); root.appendChild(p);
      }
      if (!root.childNodes.length) root.appendChild(el('p', '(empty note)'));
    }

    var noteReq = 0; // guards against out-of-order fetch responses
    function showNote(nd){
      noteReq++;
      var myReq = noteReq;
      elNote.textContent = '';
      // Head: title + close.
      var head = el('div'); head.setAttribute('class', 'kb-note-head');
      head.appendChild(el('h3', nd.title));
      var close = el('button', '✕'); close.setAttribute('class', 'kb-note-close'); close.setAttribute('title', 'Close');
      close.addEventListener('click', function(){ selected = null; hideNote(); invalidate(); });
      head.appendChild(close);
      elNote.appendChild(head);
      // Metadata chips.
      var meta = el('div'); meta.setAttribute('class', 'kb-note-meta');
      meta.appendChild(chip('type', nd.type || '—', colorFor(nd.type)));
      meta.appendChild(chip('links', String(nd.degree)));
      if (nd.confidence !== null && nd.confidence !== undefined) meta.appendChild(chip('confidence', String(nd.confidence)));
      if (nd.updatedAt) meta.appendChild(chip('updated', nd.updatedAt));
      if (nd.stale) meta.appendChild(chip('status', 'stale ≥ 90d'));
      if (nd.contradiction) meta.appendChild(chip('flag', 'contradiction'));
      meta.appendChild(chip('id', nd.id));
      elNote.appendChild(meta);
      // File path line (full location) — filled once the note fetch returns.
      var pathLine = el('div'); pathLine.setAttribute('class', 'kb-note-path');
      pathLine.style.display = 'none'; elNote.appendChild(pathLine);
      // Body — start from the excerpt, then fetch and render the FULL file.
      var body = el('div'); body.setAttribute('class', 'kb-md');
      if (nd.excerpt) renderMarkdown(body, nd.excerpt);
      var loading = el('div', 'Loading full note…'); loading.setAttribute('class', 'kb-note-loading');
      elNote.appendChild(body); elNote.appendChild(loading);
      elNote.style.display = '';
      elNote.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      // Fetch the whole markdown body for the current source scope.
      var url = apiUrl('/knowledge/note') + '?scope=' + encodeURIComponent(currentScope()) +
                '&id=' + encodeURIComponent(nd.id);
      fetch(url, { headers: { 'Accept': 'application/json' } }).then(function(res){
        if (res.status === 401){ onUnauthorized(); return null; }
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      }).then(function(data){
        if (myReq !== noteReq) return; // a newer note was opened — ignore
        if (loading.parentNode) loading.parentNode.removeChild(loading);
        if (!data) return;
        // Header enrichments from the backend: last-modified date + full path.
        if (typeof data.updated === 'string' && data.updated){
          meta.appendChild(chip('updated', String(data.updated).slice(0, 10)));
        }
        if (typeof data.path === 'string' && data.path){
          pathLine.textContent = '';
          pathLine.appendChild(el('span', '📄 ')); // page icon
          pathLine.appendChild(el('b', data.path));
          pathLine.style.display = '';
        }
        if (typeof data.body === 'string' && data.body.trim()) renderMarkdown(body, data.body);
      }).catch(function(){
        if (myReq !== noteReq) return;
        // Demo/synthetic ids have no file — keep the excerpt, just drop the spinner.
        if (loading.parentNode) loading.parentNode.removeChild(loading);
        if (!nd.excerpt) renderMarkdown(body, '(full note unavailable)');
      });
    }
    function hideNote(){ noteReq++; elNote.style.display = 'none'; elNote.textContent = ''; }

    // ---------- Legend + stats ----------
    function renderLegend(){
      elLegend.textContent = '';
      var present = {};
      G.nodes.forEach(function(o){ present[o.nd.type || 'other'] = true; });
      Object.keys(present).forEach(function(type){
        var s = el('span');
        var dot = el('i'); dot.style.background = colorFor(type === 'other' ? null : type);
        s.appendChild(dot); s.appendChild(el('span', type));
        elLegend.appendChild(s);
      });
    }

    // ---------- Load (data layer — unchanged) ----------
    function currentScope(){ return (sourceSel && sourceSel.value) || 'shared'; }
    // Demo controls only make sense for the Shared KB — an agent's own memory has no
    // synthetic demo. Hide them when an agent is picked.
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
        (data.sources || [{ id: 'shared', label: 'Shared Knowledge Base', count: 0 }]).forEach(function(s){
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
    initInteractions();
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

      // Apply one or more proposals of a run to the agent's memory via the K4
      // applier. indexes === null ⇒ accept every pending proposal in the run.
      function acceptDreams(agent, ts, indexes, btn){
        var origText = btn ? btn.textContent : '';
        if (btn){ btn.disabled = true; btn.textContent = 'Applying…'; }
        var payload = { agentId: agent, ts: ts };
        if (indexes) payload.indexes = indexes;
        fetch(apiUrl('/knowledge/dreams/apply'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        }).then(function(res){
          if (res.status === 401){ onUnauthorized(); return null; }
          return res.json().then(function(data){ return { ok: res.ok, data: data || {} }; });
        }).then(function(r){
          if (!r) return;
          if (!r.ok){
            if (btn){ btn.disabled = false; btn.textContent = origText || 'Accept'; }
            statsEl.textContent = 'Apply failed: ' + (r.data.error || 'error');
            return;
          }
          // Reload so applied proposals show ✓ and any anchor-stale skips stay
          // pending; the memory files themselves were already updated on disk.
          if (r.data.skipped){
            statsEl.textContent = 'Applied ' + r.data.applied + ', skipped ' + r.data.skipped + ' (anchor changed / net-negative)';
          }
          loadDreams(true);
        }).catch(function(e){
          if (btn){ btn.disabled = false; btn.textContent = origText || 'Accept'; }
          statsEl.textContent = 'Apply error: ' + e.message;
        });
      }

      function renderRun(run){
        var box = el('div', 'dream-run');
        var head = el('div', 'dream-run-head');
        if (run.agent) head.appendChild(el('span', 'agent', run.agent));
        var modeCls = run.mode === 'auto' ? 'auto' : 'propose';
        head.appendChild(el('span', 'dream-badge ' + modeCls, run.mode));
        head.appendChild(el('span', 'dream-badge outcome', run.outcome));
        head.appendChild(el('span', 'when', run.iso));

        // Pending = a propose-run proposal not yet manually accepted. Accept-all
        // shows only when there is something to apply.
        var pending = (run.proposals || []).filter(function(p){ return run.mode !== 'auto' && !p.accepted; });
        if (pending.length){
          var allBtn = el('button', 'dream-accept-all', 'Accept all (' + pending.length + ')');
          allBtn.title = 'Apply every pending proposal in this run to memory';
          allBtn.addEventListener('click', function(){
            acceptDreams(run.agent, run.ts, pending.map(function(p){ return p.index; }), allBtn);
          });
          head.appendChild(allBtn);
        }
        box.appendChild(head);

        if (run.summary) box.appendChild(el('div', 'dream-summary', run.summary));

        if (run.proposals && run.proposals.length){
          var props = el('div', 'dream-props');
          run.proposals.forEach(function(p){
            var pe = el('div', 'dream-prop' + (p.accepted ? ' accepted' : ''));
            var top = el('div');
            top.appendChild(el('span', 'op ' + (p.op || ''), p.op || '?'));
            top.appendChild(el('span', 'file', p.file || ''));
            top.appendChild(el('span', 'score', 'score ' + (p.score != null ? p.score : '?') + ' · recall ' + (p.recallCount != null ? p.recallCount : '?')));
            pe.appendChild(top);
            if (p.reason) pe.appendChild(el('div', 'reason', p.reason));
            if (p.target) pe.appendChild(el('div', 'anchor', 'anchor: ' + p.target));
            if (p.content) pe.appendChild(el('div', 'content', p.content));

            // Per-proposal status + accept action.
            var actions = el('div', 'dream-prop-actions');
            if (p.accepted){
              actions.appendChild(el('span', 'prop-status applied', '✓ applied'));
            } else if (run.mode === 'auto'){
              actions.appendChild(el('span', 'prop-status applied-auto', '✓ applied (auto)'));
            } else {
              actions.appendChild(el('span', 'prop-status pending', 'pending'));
              var accBtn = el('button', 'dream-accept-btn', 'Accept');
              accBtn.title = 'Apply this proposal to ' + (p.file || 'memory');
              accBtn.addEventListener('click', function(){
                acceptDreams(run.agent, run.ts, [p.index], accBtn);
              });
              actions.appendChild(accBtn);
            }
            pe.appendChild(actions);
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
        var pendingTotal = 0;
        runs.forEach(function(r){
          if (r.mode === 'auto') return;
          (r.proposals || []).forEach(function(p){ if (!p.accepted) pendingTotal++; });
        });
        statsEl.textContent = runs.length + ' run' + (runs.length === 1 ? '' : 's')
          + (pendingTotal ? ' · ' + pendingTotal + ' pending' : '');
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
