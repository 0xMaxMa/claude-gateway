/**
 * Slim, agent-scoped webview for the `/cli` command. This is deliberately NOT
 * the admin dashboard (`web-ui.ts`): the dashboard exposes every agent, the
 * process tree, and cross-agent PTY injection behind an admin key. The `/cli`
 * viewer shows exactly ONE agent's interactive (pty-shell) session, unlocked by
 * a chat approval or a verified Telegram initData — never an admin credential.
 *
 * Three pages:
 *   - device page: "waiting for approval" (Discord/LINE) or auto-initData
 *     submit (Telegram), polling until the browser is granted an access session.
 *   - viewer page: xterm.js attached to the agent's live PTY over the existing
 *     ticket→WebSocket path.
 *   - message page: terminal states (expired, opened elsewhere, denied).
 *
 * All API/WebSocket URLs are built relative to `basePath` (the path portion of
 * gateway.publicUrl, e.g. "/gateway" behind an ingress prefix) so the viewer
 * works whether the gateway is mounted at the origin root or under a prefix.
 */

const XTERM_CSS = 'https://cdn.jsdelivr.net/npm/@xterm/xterm@6.0.0/css/xterm.min.css';
const XTERM_JS = 'https://cdn.jsdelivr.net/npm/@xterm/xterm@6.0.0/lib/xterm.min.js';
const TG_WEBAPP_JS = 'https://telegram.org/js/telegram-web-app.js';

function htmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const BASE_STYLE = `
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: #0b0e14; color: #c8d3f5;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    height: 100vh; display: flex; flex-direction: column;
  }
  .center { flex: 1; display: flex; align-items: center; justify-content: center; padding: 24px; }
  .card {
    max-width: 460px; width: 100%; text-align: center;
    background: #131722; border: 1px solid #232a3b; border-radius: 14px; padding: 28px 24px;
  }
  h1 { font-size: 17px; margin: 0 0 6px; font-weight: 600; }
  .muted { color: #7a88a8; font-size: 13px; line-height: 1.5; }
  .agent { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; color: #82aaff; }
  .code {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 40px; letter-spacing: 10px; font-weight: 700; color: #c3e88d;
    margin: 18px 0 8px; padding-left: 10px;
  }
  .spinner {
    width: 26px; height: 26px; margin: 18px auto 0;
    border: 3px solid #232a3b; border-top-color: #82aaff; border-radius: 50%;
    animation: spin 0.9s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  .err { color: #ff757f; }
  .ok { color: #c3e88d; }
`;

/** Shared page shell. `body` is raw HTML; `head` optional extra tags. */
function page(title: string, style: string, body: string, head = ''): string {
  return `<!doctype html><html lang="en"><head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <title>${htmlEscape(title)}</title>
  ${head}
  <style>${style}</style>
  </head><body>${body}</body></html>`;
}

/** A plain centered message page for terminal/error states. */
export function generateCliMessagePage(title: string, message: string, tone: 'err' | 'ok' | 'muted' = 'muted'): string {
  return page(title, BASE_STYLE, `
    <div class="center"><div class="card">
      <h1>${htmlEscape(title)}</h1>
      <p class="${tone === 'muted' ? 'muted' : tone}">${htmlEscape(message)}</p>
    </div></div>`);
}

export interface CliDevicePageOpts {
  pairingId: string;
  agentId: string;
  code: string;
  channel: 'telegram' | 'discord' | 'line' | 'slack';
  basePath: string;
}

/** "Waiting for approval" device page (or Telegram initData auto-submit). */
export function generateCliDevicePage(opts: CliDevicePageOpts): string {
  const cfg = JSON.stringify({
    pairingId: opts.pairingId,
    basePath: opts.basePath,
    channel: opts.channel,
  });
  const isTelegram = opts.channel === 'telegram';
  const head = isTelegram ? `<script src="${TG_WEBAPP_JS}"></script>` : '';
  const body = `
  <div class="center"><div class="card">
    <h1>Terminal viewer</h1>
    <p class="muted">Agent <span class="agent">${htmlEscape(opts.agentId)}</span></p>
    ${isTelegram
      ? `<p class="muted" id="msg">Verifying with Telegram…</p><div class="spinner" id="spin"></div>`
      : `<div class="code">${htmlEscape(opts.code)}</div>
         <p class="muted">Confirm this code matches your chat, then tap <b>Approve</b> there.</p>
         <p class="muted" id="msg">Waiting for approval…</p><div class="spinner" id="spin"></div>`}
  </div></div>
  <script>
  (function(){
    var CFG = ${cfg};
    var msg = document.getElementById('msg');
    var spin = document.getElementById('spin');
    function base(p){ return CFG.basePath + '/cli/' + CFG.pairingId + p; }
    function fail(t){ if(msg){msg.textContent=t; msg.className='err';} if(spin) spin.style.display='none'; }
    function done(){ if(msg){msg.textContent='Approved — opening…'; msg.className='ok';} location.replace(base('/view')); }

    if (CFG.channel === 'telegram') {
      var tg = window.Telegram && window.Telegram.WebApp;
      var initData = tg && tg.initData;
      if (tg && tg.ready) { try { tg.ready(); tg.expand && tg.expand(); } catch(e){} }
      if (!initData) { fail('Please open this from the Telegram button.'); return; }
      fetch(base('/tg-init'), {
        method:'POST', headers:{'Content-Type':'application/json'},
        credentials:'same-origin', body: JSON.stringify({ initData: initData })
      }).then(function(r){ return r.ok ? r.json() : r.json().then(function(e){ throw new Error(e.error||('HTTP '+r.status)); }); })
        .then(function(d){ if(d.status==='ready') done(); else fail('Could not verify.'); })
        .catch(function(e){ fail(e.message || 'Verification failed.'); });
      return;
    }

    // Discord / LINE: poll until the chat approval lands.
    var tries = 0;
    function poll(){
      if (tries++ > 160) { fail('Timed out. Send /cli again.'); return; }
      fetch(base('/status'), { credentials:'same-origin' })
        .then(function(r){ return r.json(); })
        .then(function(d){
          if (d.status==='ready') return done();
          if (d.status==='denied') return fail('Request denied.');
          if (d.status==='gone') return fail('Link expired. Send /cli again.');
          if (d.status==='foreign') return fail('This link was opened in another browser.');
          setTimeout(poll, 1500);
        })
        .catch(function(){ setTimeout(poll, 2000); });
    }
    poll();
  })();
  </script>`;
  return page('Terminal viewer', BASE_STYLE, body, head);
}

export interface CliViewerPageOpts {
  pairingId: string;
  agentId: string;
  basePath: string;
}

/** The xterm.js viewer, scoped to a single agent's PTY sessions. */
export function generateCliViewerPage(opts: CliViewerPageOpts): string {
  const cfg = JSON.stringify({
    pairingId: opts.pairingId,
    agentId: opts.agentId,
    basePath: opts.basePath,
  });
  const style = `${BASE_STYLE}
    body { background:#000; }
    header {
      display:flex; align-items:center; gap:10px; padding:8px 12px;
      background:#0b0e14; border-bottom:1px solid #232a3b; font-size:13px; flex:0 0 auto;
    }
    header .status { color:#7a88a8; margin-left:auto; }
    select, button {
      background:#131722; color:#c8d3f5; border:1px solid #2b3450; border-radius:8px;
      padding:6px 10px; font-size:13px; cursor:pointer;
    }
    button.on { background:#1f6feb; border-color:#1f6feb; color:#fff; }
    #term { flex:1; min-height:0; padding:6px; }
    .hint { color:#7a88a8; padding:16px; font-size:13px; }
    /* Shortcut keys — inline in the header, only shown in input mode. Compact but
       still touch-friendly for mobile webviews. */
    #keybar { display:none; align-items:center; gap:4px; }
    #keybar button {
      min-width:30px; min-height:30px; font-size:13px; line-height:1;
      padding:4px 8px; touch-action:manipulation; -webkit-user-select:none; user-select:none;
    }
    #keybar button:active { background:#1f6feb; border-color:#1f6feb; color:#fff; }
    #keybar .esc { font-weight:600; }
  `;
  const body = `
  <header>
    <select id="sess" title="Session" style="display:none"></select>
    <button id="toggle" title="Toggle input">🔒 Read-only</button>
    <div id="keybar">
      <button type="button" class="esc" data-seq="esc" title="Escape">Esc</button>
      <button type="button" data-seq="left" title="Arrow Left" aria-label="Arrow Left">◀</button>
      <button type="button" data-seq="up" title="Arrow Up" aria-label="Arrow Up">▲</button>
      <button type="button" data-seq="down" title="Arrow Down" aria-label="Arrow Down">▼</button>
      <button type="button" data-seq="right" title="Arrow Right" aria-label="Arrow Right">▶</button>
    </div>
    <span class="status" id="status">connecting…</span>
  </header>
  <div id="term"></div>
  <link rel="stylesheet" href="${XTERM_CSS}">
  <script src="${XTERM_JS}"></script>
  <script>
  (function(){
    var CFG = ${cfg};
    function api(p){ return CFG.basePath + '/cli/' + CFG.pairingId + p; }
    var statusEl = document.getElementById('status');
    var sel = document.getElementById('sess');
    var toggleBtn = document.getElementById('toggle');
    var keybar = document.getElementById('keybar');
    function setStatus(t){ statusEl.textContent = t; }
    var ESC = String.fromCharCode(27);

    var term = new Terminal({
      cols: 200, rows: 50, scrollback: 0, disableStdin: true, convertEol: false,
      fontSize: 12, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      theme: { background: '#000000' }
    });
    term.open(document.getElementById('term'));

    var ws = null, inputMode = false, onDataDisposable = null, currentSession = null, reconnectT = null;

    function wsSend(s){ if (s && ws && ws.readyState===1) ws.send(s); }

    // Map a shortcut button to the bytes a real key would send. Arrow keys depend
    // on the terminal's DECCKM (application cursor keys) state — xterm.js exposes
    // it via term.modes; fall back to the normal-mode CSI form when unavailable.
    function keySeq(name){
      var app = term.modes && term.modes.applicationCursorKeysMode;
      var p = app ? 'O' : '[';
      switch (name) {
        case 'esc':   return ESC;
        case 'up':    return ESC + p + 'A';
        case 'down':  return ESC + p + 'B';
        case 'right': return ESC + p + 'C';
        case 'left':  return ESC + p + 'D';
      }
      return '';
    }

    Array.prototype.forEach.call(keybar.querySelectorAll('button'), function(btn){
      // preventDefault on press keeps the terminal's hidden textarea focused so the
      // mobile soft keyboard does not dismiss when a shortcut is tapped.
      btn.addEventListener('mousedown', function(e){ e.preventDefault(); });
      btn.addEventListener('touchstart', function(e){ e.preventDefault(); wsSend(keySeq(btn.getAttribute('data-seq'))); }, { passive:false });
      btn.addEventListener('click', function(e){ e.preventDefault(); wsSend(keySeq(btn.getAttribute('data-seq'))); });
    });

    function setInputMode(on){
      inputMode = on;
      term.options.disableStdin = !on;
      toggleBtn.className = on ? 'on' : '';
      toggleBtn.textContent = on ? '⌨️ Input ON' : '🔒 Read-only';
      keybar.style.display = on ? 'flex' : 'none';
      if (onDataDisposable) { onDataDisposable.dispose(); onDataDisposable = null; }
      if (on) { onDataDisposable = term.onData(function(d){ if (ws && ws.readyState===1) ws.send(d); }); }
    }
    toggleBtn.addEventListener('click', function(){ setInputMode(!inputMode); });

    function wsUrl(ticket){
      var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      return proto + '//' + location.host + CFG.basePath +
        '/api/v1/agents/' + encodeURIComponent(CFG.agentId) + '/pty-stream?ticket=' + encodeURIComponent(ticket);
    }

    function connect(sessionId){
      currentSession = sessionId;
      if (ws) { try { ws.close(); } catch(e){} ws = null; }
      setStatus('authorizing…');
      fetch(api('/pty-ticket'), {
        method:'POST', headers:{'Content-Type':'application/json'},
        credentials:'same-origin', body: JSON.stringify({ sessionId: sessionId })
      }).then(function(r){
        if (r.status===401){ setStatus('session expired — send /cli again'); throw new Error('unauth'); }
        return r.json();
      }).then(function(d){
        if (!d.ticket) throw new Error('no ticket');
        ws = new WebSocket(wsUrl(d.ticket));
        ws.binaryType = 'arraybuffer';
        var dec = new TextDecoder();
        ws.onopen = function(){ setStatus(''); };
        ws.onmessage = function(ev){
          var data = typeof ev.data === 'string' ? ev.data : dec.decode(ev.data, { stream:true });
          term.write(data);
        };
        ws.onclose = function(ev){
          setStatus('disconnected');
          if (ev.code === 4404) { setStatus('session ended'); return; }
          if (sessionId === currentSession) { clearTimeout(reconnectT); reconnectT = setTimeout(function(){ connect(sessionId); }, 2000); }
        };
        ws.onerror = function(){ try { ws.close(); } catch(e){} };
      }).catch(function(){ /* status already set */ });
    }

    function loadSessions(){
      setStatus('finding session…');
      fetch(api('/sessions'), { credentials:'same-origin' })
        .then(function(r){ if(r.status===401){ setStatus('session expired'); throw new Error('unauth'); } return r.json(); })
        .then(function(d){
          var list = (d && d.sessions) || [];
          if (!list.length) {
            setStatus('');
            document.getElementById('term').innerHTML = '<div class="hint">No interactive session to view. The agent must be running with headless=false to expose a live terminal.</div>';
            return;
          }
          if (list.length > 1) {
            sel.style.display = '';
            sel.innerHTML = '';
            list.forEach(function(s){
              var o = document.createElement('option');
              o.value = s.sessionId;
              o.textContent = (s.source||'session') + ' · ' + s.sessionId.slice(0,8);
              sel.appendChild(o);
            });
            sel.addEventListener('change', function(){ connect(sel.value); });
          }
          setInputMode(false);
          connect(list[0].sessionId);
        })
        .catch(function(){ /* status set */ });
    }

    loadSessions();
  })();
  </script>`;
  return page('Terminal viewer', style, body);
}
