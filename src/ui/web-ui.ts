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
      margin-bottom: 24px;
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
    #pty-terminal { padding: 8px; background: #0d1117; }
    .proc-tree {
      font-family: monospace;
      font-size: 0.82rem;
      background: #0d1117;
      border: 1px solid #2d3748;
      border-radius: 6px;
      padding: 12px 16px;
      white-space: pre;
      color: #a0aec0;
      overflow-x: auto;
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

  <!-- Agent status badges -->
  <div class="agents-bar" id="agents-bar"></div>

  <!-- 70% / 30% layout — Sessions left, Processes right -->
  <div style="display:grid;grid-template-columns:6fr 4fr;gap:24px;align-items:start;">

    <!-- Left column: Sessions table -->
    <div>
      <h2>Sessions</h2>
      <table id="sessions-table">
        <thead>
          <tr>
            <th>Agent</th>
            <th>Session ID</th>
            <th>Chat ID</th>
            <th>Source</th>
            <th>Status</th>
            <th>Uptime</th>
            <th>Spawned</th>
            <th>Live</th>
          </tr>
        </thead>
        <tbody id="sessions-tbody">
          <tr><td colspan="8" class="ts">Loading...</td></tr>
        </tbody>
      </table>

      <div class="pty-viewer" id="pty-viewer">
        <div class="pty-viewer-header">
          <span>PTY Live &mdash; <span class="agent-label" id="pty-agent-label"></span></span>
          <button class="pty-close" id="pty-close-btn" title="Close">&#x2715;</button>
        </div>
        <div id="pty-terminal"></div>
      </div>
    </div>

    <!-- Right column: Processes -->
    <div>
      <h2>Processes</h2>
      <div class="proc-tree" id="proc-tree">Loading...</div>
    </div>
  </div>

  <div id="error-msg" class="error" style="display:none;"></div>

  <script src="https://cdn.jsdelivr.net/npm/xterm@5.3.0/lib/xterm.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/xterm-addon-fit@0.8.0/lib/xterm-addon-fit.min.js"></script>
  <script>
    // Read API key from meta tag (safe — no inline JS string injection)
    const DASHBOARD_API_KEY = document.querySelector('meta[name="api-key"]') ? document.querySelector('meta[name="api-key"]').getAttribute('content') : '';

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
    let fitAddon = null;
    let ptyWs = null;
    let currentPtyAgent = null;

    function openPtyViewer(agentId) {
      if (currentPtyAgent === agentId && ptyWs && ptyWs.readyState === WebSocket.OPEN) return;
      closePtyViewer();

      currentPtyAgent = agentId;
      document.getElementById('pty-agent-label').textContent = agentId;
      document.getElementById('pty-viewer').style.display = 'block';

      if (!term) {
        term = new Terminal({
          theme: { background: '#0d1117', foreground: '#e2e8f0', cursor: '#63b3ed' },
          fontSize: 13,
          fontFamily: 'Menlo, Monaco, Consolas, monospace',
          convertEol: true,
          scrollback: 2000,
        });
        fitAddon = new FitAddon.FitAddon();
        term.loadAddon(fitAddon);
        term.open(document.getElementById('pty-terminal'));
        fitAddon.fit();
      } else {
        term.clear();
      }

      const url = wsUrl('/api/v1/agents/' + encodeURIComponent(agentId) + '/pty-stream');
      ptyWs = new WebSocket(url);
      ptyWs.binaryType = 'arraybuffer';

      ptyWs.onopen = function() { term.writeln('\\r\\x1b[32m[connected to ' + agentId + ']\\x1b[0m'); };
      ptyWs.onmessage = function(ev) {
        const data = ev.data instanceof ArrayBuffer ? new TextDecoder().decode(ev.data) : ev.data;
        term.write(data);
      };
      ptyWs.onclose = function(ev) {
        if (term) term.writeln('\\r\\x1b[33m[disconnected: ' + (ev.reason || 'closed') + ']\\x1b[0m');
      };
      ptyWs.onerror = function() { if (term) term.writeln('\\r\\x1b[31m[connection error]\\x1b[0m'); };
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

    // ── Status Refresh ────────────────────────────────────────────────────────
    async function refresh() {
      document.getElementById('refresh-indicator').textContent = 'refreshing...';
      try {
        const res = await fetch(apiUrl('/status'));
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const data = await res.json();

        document.getElementById('uptime').textContent = fmtUptime(data.uptime || 0);
        document.getElementById('started-at').textContent = data.startedAt
          ? new Date(data.startedAt).toLocaleString() : '&mdash;';
        document.getElementById('last-updated').textContent = new Date().toLocaleTimeString();
        if (data.version) document.getElementById('gateway-version').textContent = 'v' + data.version;
        document.getElementById('error-msg').style.display = 'none';

        // Agent badges bar
        const badges = (data.agents || []).map(function(a) {
          const dot = a.isRunning ? '<span class="dot-green">&#x25CF;</span>' : '<span class="dot-red">&#x25CF;</span>';
          return '<span class="agent-badge">' + dot + ' <span class="agent-name">' + escHtml(a.id) + '</span></span>';
        });
        document.getElementById('agents-bar').innerHTML = badges.join('') || '<span class="ts">No agents</span>';

        // Sessions table — flat list with agent column
        const rows = [];
        (data.agents || []).forEach(function(a) {
          const sessions = a.sessions || [];
          if (sessions.length === 0) {
            rows.push(
              '<tr class="session-row">' +
              '<td><span class="ts">' + escHtml(a.id) + '</span></td>' +
              '<td colspan="7" class="ts">no sessions</td>' +
              '</tr>'
            );
          } else {
            sessions.forEach(function(s) {
              const statusBadge = s.isRunning
                ? '<span class="badge badge-green">running</span>'
                : '<span class="badge badge-gray">stopped</span>';
              const uptime = s.isRunning ? fmtUptime(s.uptimeSec || 0) : '<span class="ts">&mdash;</span>';
              const sessId = s.sessionId
                ? '<span class="session-id">' + escHtml(s.sessionId) + '</span>'
                : '<span class="ts">&mdash;</span>';
              const liveBtn = (a.hasPtyStream && s.isRunning)
                ? '<button class="btn-stream" data-agent-id="' + escHtml(a.id) + '">▶ Live</button>'
                : '<span class="ts">&mdash;</span>';
              rows.push(
                '<tr class="session-row">' +
                '<td><span style="color:#90cdf4;font-weight:600;">' + escHtml(a.id) + '</span></td>' +
                '<td>' + sessId + '</td>' +
                '<td class="ts">' + escHtml(String(s.chatId || '&mdash;')) + '</td>' +
                '<td>' + escHtml(s.source || '&mdash;') + '</td>' +
                '<td>' + statusBadge + '</td>' +
                '<td>' + uptime + '</td>' +
                '<td>' + fmtTs(s.spawnedAt ? new Date(s.spawnedAt).toISOString() : null) + '</td>' +
                '<td>' + liveBtn + '</td>' +
                '</tr>'
              );
            });
          }
        });

        document.getElementById('sessions-tbody').innerHTML =
          rows.length ? rows.join('') : '<tr><td colspan="8" class="ts">No sessions</td></tr>';

        document.getElementById('refresh-indicator').textContent = 'auto-refresh 5s';
      } catch(e) {
        document.getElementById('error-msg').textContent = 'Error fetching status: ' + e.message;
        document.getElementById('error-msg').style.display = 'block';
        document.getElementById('refresh-indicator').textContent = 'error';
      }
    }

    function escHtml(s) {
      return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
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

      function short(args, maxLen) {
        return args.length > maxLen ? args.slice(0, maxLen) + '\\u2026' : args;
      }

      function sessionId(args) {
        const m = args.match(/--session-id\\s+(\\S+)/);
        return m ? m[1].slice(0, 8) + '\\u2026' : '?';
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
        lines.push('  PID ' + orchestrator.pid + '  <span class="proc-orchestrator">' + short(orchestrator.args, 40) + '</span>');
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
          lines.push('  \\u26a0 PID ' + p.pid + '  <span class="proc-orphan">' + short(p.args, 30) + '</span>');
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
