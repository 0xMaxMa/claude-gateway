/**
 * Generates a self-contained HTML dashboard page for the gateway status UI.
 * No external dependencies except xterm.js CDN for PTY viewer.
 */
export function generateDashboardHtml(apiKey = ''): string {
  const safeKey = apiKey.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="api-key" content="${safeKey}">
  <title>Claude Gateway</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/xterm@5.3.0/css/xterm.min.css"/>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, monospace;
      background: #0f1117;
      color: #e2e8f0;
      padding: 24px;
    }
    h1 { color: #63b3ed; font-size: 1.5rem; margin-bottom: 8px; }
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
    .ts { color: #718096; font-size: 0.8rem; }
    #refresh-indicator { float: right; font-size: 0.75rem; color: #4a5568; }
    .error { color: #fc8181; font-size: 0.85rem; margin-top: 8px; }
    .btn-stream {
      background: #1a365d;
      color: #63b3ed;
      border: 1px solid #2b6cb0;
      border-radius: 4px;
      padding: 2px 8px;
      font-size: 0.75rem;
      cursor: pointer;
    }
    .btn-stream:hover { background: #2b6cb0; color: #ebf8ff; }
    .pty-viewer {
      display: none;
      margin-top: 24px;
      border: 1px solid #2d3748;
      border-radius: 6px;
      overflow: hidden;
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
    .pty-close {
      background: none;
      border: none;
      color: #718096;
      cursor: pointer;
      font-size: 1rem;
      padding: 0 4px;
    }
    .pty-close:hover { color: #fc8181; }
    /* Fixed-size terminal viewport — the server PTY runs at 200x50, so the
       viewer must NOT resize to the panel (that mismatch is what garbles the
       output). We render at the native size and scroll if it overflows. */
    #pty-terminal {
      padding: 8px;
      background: #0d1117;
      overflow: auto;
      max-height: 70vh;
      border-radius: 6px;
    }
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
  </style>
</head>
<body>
  <h1>Claude Gateway <span id="gateway-version" style="font-size:0.75rem;color:#718096;"></span> <span id="refresh-indicator">refreshing...</span></h1>
  <div class="meta">
    Uptime: <span id="uptime">&mdash;</span> &nbsp;|&nbsp;
    Started: <span id="started-at">&mdash;</span> &nbsp;|&nbsp;
    Last updated: <span id="last-updated">&mdash;</span>
  </div>

  <!-- Row: Processes 70% | Agent badges 30% -->
  <div style="display:grid;grid-template-columns:7fr 3fr;gap:24px;align-items:start;">
    <div>
      <h2>Processes</h2>
      <div class="proc-tree" id="proc-tree">Loading...</div>
    </div>
    <div>
      <h2>Agents</h2>
      <div class="agents-bar" id="agents-bar"></div>
    </div>
  </div>

  <!-- Sessions — full width (session-centric, flat list) -->
  <h2>Sessions</h2>
  <table id="sessions-table">
    <thead>
      <tr>
        <th>Agent</th>
        <th>Session ID</th>
        <th>Chat ID</th>
        <th>Source</th>
        <th>Mode</th>
        <th>Model</th>
        <th>Status</th>
        <th>Uptime</th>
        <th>Spawned</th>
        <th>Live</th>
      </tr>
    </thead>
    <tbody id="sessions-tbody">
      <tr><td colspan="10" class="ts">Loading...</td></tr>
    </tbody>
  </table>

  <!-- PTY viewer — full width so the native 200-col terminal has room -->
  <div class="pty-viewer" id="pty-viewer">
    <div class="pty-viewer-header">
      <span>PTY Live &mdash; <span class="agent-label" id="pty-agent-label"></span></span>
      <button class="pty-close" id="pty-close-btn" title="Close">&#x2715;</button>
    </div>
    <div id="pty-terminal"></div>
  </div>

  <div id="error-msg" class="error" style="display:none;"></div>

  <script src="https://cdn.jsdelivr.net/npm/xterm@5.3.0/lib/xterm.min.js"></script>
  <script>
    // Read API key from meta tag (safe — no inline JS string injection)
    const DASHBOARD_API_KEY = document.querySelector('meta[name="api-key"]') ? document.querySelector('meta[name="api-key"]').getAttribute('content') : '';

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

    function fmtTs(ts) {
      if (!ts) return '<span class="ts">&mdash;</span>';
      try {
        const d = new Date(ts);
        return '<span class="ts">' + d.toLocaleTimeString() + ' ' + d.toLocaleDateString() + '</span>';
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

    function wsUrl(path) {
      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const base = proto + '//' + window.location.host + basePath() + path;
      return DASHBOARD_API_KEY ? base + (base.includes('?') ? '&' : '?') + 'key=' + encodeURIComponent(DASHBOARD_API_KEY) : base;
    }

    // ── PTY Viewer ───────────────────────────────────────────────────────────
    let term = null;
    let ptyWs = null;
    let currentPtyAgent = null;
    // Streaming UTF-8 decoder. The PTY stream carries raw UTF-8 bytes (box-drawing
    // chars, spinner braille, emoji). Decoding them as latin1 mangles every
    // multi-byte char into noise — decode as UTF-8 with {stream:true} so sequences
    // split across WebSocket frames are reassembled instead of corrupted.
    let utf8Decoder = null;

    function openPtyViewer(agentId) {
      if (currentPtyAgent === agentId && ptyWs && ptyWs.readyState === WebSocket.OPEN) return;
      closePtyViewer();

      currentPtyAgent = agentId;
      document.getElementById('pty-agent-label').textContent = agentId;
      document.getElementById('pty-viewer').style.display = 'block';

      if (!term) {
        term = new Terminal({
          theme: { background: '#0d1117', foreground: '#e2e8f0', cursor: '#63b3ed' },
          fontSize: 10,
          lineHeight: 1.0,
          letterSpacing: 0,
          fontFamily: '"JetBrains Mono", "Cascadia Code", Menlo, Monaco, Consolas, "Courier New", monospace',
          fontWeight: 400,
          fontWeightBold: 600,
          // Fixed dimensions matching the server PTY — do NOT auto-fit, the
          // size mismatch is what makes the output unreadable.
          cols: PTY_COLS,
          rows: PTY_ROWS,
          scrollback: 5000,
          // View-only mirror of the agent's TUI.
          disableStdin: true,
          cursorBlink: false,
          convertEol: false,
        });
        term.open(document.getElementById('pty-terminal'));
      } else {
        term.reset();
      }

      // Fresh decoder per session so a leftover partial byte from a previous
      // viewing can't corrupt the first character of this stream.
      utf8Decoder = new TextDecoder('utf-8');

      const url = wsUrl('/api/v1/agents/' + encodeURIComponent(agentId) + '/pty-stream');
      ptyWs = new WebSocket(url);
      ptyWs.binaryType = 'arraybuffer';

      ptyWs.onmessage = function(ev) {
        const data = ev.data instanceof ArrayBuffer
          ? utf8Decoder.decode(ev.data, { stream: true })
          : ev.data;
        term.write(data);
      };
      ptyWs.onclose = function(ev) {
        if (term) term.writeln('\\r\\n\\x1b[33m[disconnected: ' + (ev.reason || 'closed') + ']\\x1b[0m');
      };
      ptyWs.onerror = function() { if (term) term.writeln('\\r\\n\\x1b[31m[connection error]\\x1b[0m'); };
    }

    function closePtyViewer() {
      if (ptyWs) { ptyWs.close(); ptyWs = null; }
      currentPtyAgent = null;
      document.getElementById('pty-viewer').style.display = 'none';
    }

    document.getElementById('pty-close-btn').addEventListener('click', closePtyViewer);

    // Event delegation for Live buttons (avoids inline onclick + HTML injection)
    document.getElementById('sessions-tbody').addEventListener('click', function(e) {
      const btn = e.target.closest('.btn-stream');
      if (btn) openPtyViewer(btn.getAttribute('data-agent-id'));
    });

    function escHtml(s) {
      return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }

    function modeBadge(mode) {
      if (mode === 'pty-shell') return '<span class="badge badge-blue">pty-shell</span>';
      if (mode === 'headless') return '<span class="badge badge-purple">headless</span>';
      return '<span class="ts">' + escHtml(mode || '?') + '</span>';
    }

    // Prettify a model id for display: drop the "claude-" prefix and any
    // trailing date stamp, e.g. claude-haiku-4-5-20251001 -> haiku-4-5.
    // Full id is kept in the tooltip.
    function fmtModel(m) {
      if (!m) return '<span class="ts">&mdash;</span>';
      const label = String(m).replace(/^claude-/, '').replace(/-\\d{8}$/, '');
      return '<span class="badge badge-gray" title="' + escHtml(m) + '">' + escHtml(label) + '</span>';
    }

    // ── Status Refresh ────────────────────────────────────────────────────────
    async function refresh() {
      document.getElementById('refresh-indicator').textContent = 'refreshing...';
      try {
        const res = await fetch(apiUrl('/status'));
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
            const liveBtn = (a.hasPtyStream && s.isRunning && s.mode === 'pty-shell')
              ? '<button class="btn-stream" data-agent-id="' + escHtml(a.id) + '">▶ Live</button>'
              : '<span class="ts">&mdash;</span>';
            rows.push(
              '<tr class="session-row">' +
              '<td><span style="color:#90cdf4;font-weight:600;">' + escHtml(a.id) + '</span></td>' +
              '<td>' + sessId + '</td>' +
              '<td>' + chatCell + '</td>' +
              '<td><span class="badge badge-gray">' + escHtml(s.source || '?') + '</span></td>' +
              '<td>' + modeBadge(s.mode) + '</td>' +
              '<td>' + fmtModel(s.model) + '</td>' +
              '<td>' + statusBadge + '</td>' +
              '<td>' + uptime + '</td>' +
              '<td>' + fmtTs(s.spawnedAt ? new Date(s.spawnedAt).toISOString() : null) + '</td>' +
              '<td>' + liveBtn + '</td>' +
              '</tr>'
            );
          });
        });

        document.getElementById('sessions-tbody').innerHTML =
          rows.length ? rows.join('') : '<tr><td colspan="10" class="ts">No active sessions</td></tr>';

        document.getElementById('refresh-indicator').textContent = 'auto-refresh 5s';
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
        if (!res.ok) return;
        const data = await res.json();
        renderProcessTree(data.processes || []);
      } catch(e) {
        document.getElementById('proc-tree').textContent = 'Error: ' + e.message;
      }
    }

    function renderProcessTree(procs) {
      if (!procs.length) {
        document.getElementById('proc-tree').textContent = '— no gateway processes found —';
        return;
      }

      const pidMap = {};
      procs.forEach(function(p) { pidMap[p.pid] = p; });

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
        lines.push('  PID ' + pty.pid + '  <span class="proc-pty">pty-shell</span>  [' + agent + ']');
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
      if (telegramReceivers.length) lines.push('  TG \\u00d7' + telegramReceivers.length);
      if (discordReceivers.length) lines.push('  DC \\u00d7' + discordReceivers.length);
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

    refresh();
    refreshProcesses();
    setInterval(refresh, 5000);
    setInterval(refreshProcesses, 10000);
  </script>
</body>
</html>`;
}
