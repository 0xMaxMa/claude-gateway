/**
 * Unit tests for the interactive Terminal Viewer + localhost-only bind
 * (Issue #201). Covers the pure, testable seams of the feature:
 *   - resolveBindHost precedence (env → config → localhost default)
 *   - the shipped config.template.json (new fields + configVersion bump)
 *   - the config migrator picking up the new gateway fields on an old config
 *   - the generated dashboard HTML (mode toggle markers + valid embedded JS).
 *     Interactive input is opt-in per browser via the viewer's mode toggle;
 *     access to the socket is gated upstream by auth + the localhost bind.
 *
 * The WS-frame gate and the wrapper input validation are covered in
 * control-channel.test.ts (shared pure helpers); here we verify the wiring
 * points that turn those helpers into the shipped feature.
 */

import * as path from 'path'
import * as fs from 'fs'
import { resolveBindHost } from '../../src/api/gateway-router'
import { generateDashboardHtml } from '../../src/ui/web-ui'
import { deepMerge } from '../../src/config/migrator'

const TEMPLATE_PATH = path.join(__dirname, '../../config.template.json')

describe('resolveBindHost — bind precedence (Issue #201)', () => {
  test('U-BIND-01: defaults to localhost when nothing is set', () => {
    expect(resolveBindHost(undefined, undefined)).toBe('127.0.0.1')
    expect(resolveBindHost('', '')).toBe('127.0.0.1')
    expect(resolveBindHost('   ', '   ')).toBe('127.0.0.1') // blank falls through
  })

  test('U-BIND-02: config bind is used when set and no env override', () => {
    expect(resolveBindHost(undefined, '0.0.0.0')).toBe('0.0.0.0')
    expect(resolveBindHost('', '192.168.1.5')).toBe('192.168.1.5')
  })

  test('U-BIND-03: env var takes precedence over config', () => {
    expect(resolveBindHost('0.0.0.0', '127.0.0.1')).toBe('0.0.0.0')
    expect(resolveBindHost('10.0.0.1', '0.0.0.0')).toBe('10.0.0.1')
  })

  test('U-BIND-04: values are trimmed', () => {
    expect(resolveBindHost(' 0.0.0.0 ', undefined)).toBe('0.0.0.0')
    expect(resolveBindHost(undefined, ' 127.0.0.1 ')).toBe('127.0.0.1')
  })
})

describe('config.template.json — shipped defaults (Issue #201)', () => {
  const template = JSON.parse(fs.readFileSync(TEMPLATE_PATH, 'utf8')) as {
    configVersion: string
    gateway: { bind?: string; dashboard?: unknown }
  }

  test('U-TMPL-01: bind defaults to localhost-only', () => {
    expect(template.gateway.bind).toBe('127.0.0.1')
  })

  test('U-TMPL-02: no dashboard.interactiveInput flag ships (toggle-only feature)', () => {
    // Interactive input is controlled entirely by the client-side viewer toggle;
    // there is no server config flag, so the template must not carry one.
    expect(template.gateway.dashboard).toBeUndefined()
  })

  test('U-TMPL-03: configVersion was bumped to at least 1.0.13', () => {
    // The new fields only reach existing users if the template version leads;
    // this locks in the bump so a future edit cannot silently drop it.
    const [maj, min, pat] = template.configVersion.split('.').map((n) => parseInt(n, 10))
    expect(maj).toBe(1)
    expect(min * 1000 + pat).toBeGreaterThanOrEqual(13) // >= 1.0.13
  })
})

describe('config migrator — merges new gateway fields into an old config', () => {
  test('U-MIG-01: deepMerge adds gateway.bind, keeps existing values', () => {
    // An existing user config predating Issue #201 (no bind).
    const userConfig: Record<string, unknown> = {
      configVersion: '1.0.12',
      gateway: { logDir: '/my/logs', headless: false },
    }
    // The relevant slice of the new template.
    const template: Record<string, unknown> = {
      configVersion: '1.0.13',
      gateway: {
        logDir: '/default/logs',
        bind: '127.0.0.1',
        headless: true,
      },
    }
    const added: string[] = []
    deepMerge(userConfig, template, '', added)

    const gw = userConfig.gateway as Record<string, unknown>
    // New field merged in…
    expect(gw.bind).toBe('127.0.0.1')
    // deepMerge records the newly-added leaf under an existing parent.
    expect(added).toContain('gateway.bind')
    // …without clobbering the user's existing overrides.
    expect(gw.logDir).toBe('/my/logs')
    expect(gw.headless).toBe(false)
  })
})

describe('dashboard HTML — mode toggle + embedded JS (Issue #201)', () => {
  /** Pull the last <script>…</script> block (the dashboard logic) out of the page. */
  function scriptBody(html: string): string {
    const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
    expect(blocks.length).toBeGreaterThan(0)
    return blocks[blocks.length - 1]![1]!
  }

  test('U-UI-01: the mode toggle button and swappable title are always in the markup', () => {
    const html = generateDashboardHtml()
    expect(html).toContain('id="pty-mode-toggle-btn"')
    expect(html).toContain('id="pty-title-text"')
    expect(html).toContain('Terminal Viewer')
  })

  test('U-UI-02: the mode toggle ships visible (no inline display:none gate)', () => {
    // With no server flag, the toggle is always rendered — its button markup
    // must not be hidden with an inline style the way the gated version was.
    const html = generateDashboardHtml()
    const btn = html.match(/<button class="pty-mode-toggle"[^>]*>/)![0]
    expect(btn).not.toContain('display:none')
  })

  test('U-UI-03: the embedded dashboard script is syntactically valid', () => {
    const body = scriptBody(generateDashboardHtml())
    // Parse-only: throws on a syntax error, does not execute (no DOM needed).
    expect(() => new Function(body)).not.toThrow()
  })

  test('U-UI-03b: the Knowledge base graph script is present and syntactically valid', () => {
    const html = generateDashboardHtml()
    const m = html.match(/<script id="kb-graph">([\s\S]*?)<\/script>/)
    expect(m).not.toBeNull()
    const body = m![1]!
    expect(body).toContain('loadGraph') // fetches /knowledge/graph
    expect(body).toContain("apiUrl('/knowledge/graph')")
    // Parse-only: a syntax error in the hand-rolled renderer would break the dashboard.
    expect(() => new Function(body)).not.toThrow()
  })

  test('U-UI-03c: the Knowledge base graph ships a node search control', () => {
    const html = generateDashboardHtml()
    // The search input lives in the toolbar…
    expect(html).toContain('id="kb-search"')
    expect(html).toContain('id="kb-search-count"')
    const body = html.match(/<script id="kb-graph">([\s\S]*?)<\/script>/)![1]!
    // …and is wired to a filter that marks matching notes (canvas render dims the rest).
    expect(body).toContain('function runSearch')
    expect(body).toContain('function clearSearch')
    expect(body).toContain('o.hit') // per-node match flag the renderer reads
    expect(body).toContain("elSearch.addEventListener('input', runSearch)")
    // Enter focuses the first match (rotates it to the front); re-applied after a rebuild.
    expect(body).toContain('function focusFirstMatch')
  })

  test('U-UI-03d: the Knowledge base graph ships a source selector (shared / per-agent)', () => {
    const html = generateDashboardHtml()
    expect(html).toContain('id="kb-source"')
    const body = html.match(/<script id="kb-graph">([\s\S]*?)<\/script>/)![1]!
    // Populates from /knowledge/sources and threads ?scope= into the graph fetch.
    expect(body).toContain("apiUrl('/knowledge/sources')")
    expect(body).toContain('function loadSources')
    expect(body).toContain("'?scope='")
  })

  test('U-UI-03f: the Nightly dreaming tab ships an accept action wired to the apply endpoint', () => {
    const html = generateDashboardHtml()
    const body = html.match(/<script id="kb-dreams">([\s\S]*?)<\/script>/)![1]!
    // The accept action POSTs the run + selected indexes to the apply endpoint.
    expect(body).toContain('function acceptDreams')
    expect(body).toContain("apiUrl('/knowledge/dreams/apply')")
    expect(body).toContain('run.ts') // targets a specific run
    expect(body).toContain('p.accepted') // renders per-proposal accepted state
    expect(body).toContain('Accept all') // bulk action per run
    // Parse-only: a syntax error in the hand-rolled renderer would break the dashboard.
    expect(() => new Function(body)).not.toThrow()
  })

  test('U-UI-03e: the graph is a 3D canvas that auto-spins and drag-rotates (no pan / no center button)', () => {
    const html = generateDashboardHtml()
    const body = html.match(/<script id="kb-graph">([\s\S]*?)<\/script>/)![1]!
    // The graph renders to a <canvas>, not an SVG plane.
    expect(html).toContain('id="kb-canvas"')
    expect(html).not.toContain('id="kb-svg"')
    // It auto-spins continuously (the reference "หมุนวนไปเรื่อย ๆ" behaviour) via a
    // named baseline speed constant applied every frame…
    expect(body).toContain('SPIN = 0.0025')
    expect(body).toContain('rotY += SPIN')
    // …and dragging empty space ROTATES the sphere (X drag → spin, Y drag → tilt),
    // which a flat-SVG pan could never do. A drag adjusts both rotation axes.
    expect(body).toContain('(e.clientX - lastX) * 0.01')
    expect(body).toContain('(e.clientY - lastY) * 0.01')
    expect(body).toContain('rotY += dY')
    expect(body).toContain('rotX += dX')
    // Always centred by projection → the old "Center" button + pan are gone for good.
    expect(html).not.toContain('id="kb-center"')
    expect(body).not.toContain('onPointerMove')
    // Wheel still zooms.
    expect(body).toContain("addEventListener('wheel'")
  })

  test('U-UI-11: release momentum, +/- zoom buttons + wider clamp, renamed source, 300 default demo, styled agent select', () => {
    const html = generateDashboardHtml()
    const body = html.match(/<script id="kb-graph">([\s\S]*?)<\/script>/)![1]!
    // (1) Releasing a drag keeps the sphere orbiting — the last drag speed is captured
    // as angular momentum, then decayed frame-by-frame instead of freezing dead.
    expect(body).toContain('velY = dY')          // capture drag speed
    expect(body).toContain('velY *= 0.95')       // decay after release
    expect(body).toContain('if (dragging) auto = true') // resume orbit on release
    // (4) Wider zoom range + on-screen +/- buttons sharing one clamped zoomBy().
    expect(body).toContain('MAX_ZOOM = 8')
    expect(body).toContain('function zoomBy')
    expect(html).toContain('id="kb-zoom-in"')
    expect(html).toContain('id="kb-zoom-out"')
    // (2) Source label spelled out in full.
    expect(html).toContain('>Shared Knowledge Base</option>')
    expect(html).not.toContain('>Shared KB<')
    // (3) Demo size defaults to 300 nodes.
    expect(html).toContain('<option value="300" selected>300</option>')
    // (5) The dreaming Agent <select> shares the dark control styling of the KB selects.
    expect(html).toContain('#kb-demo-size, #kb-source, #dreams-agent')
  })

  test('U-UI-06: the Nightly dreaming report script is present and valid', () => {
    const html = generateDashboardHtml()
    // Third tab + its view container.
    expect(html).toContain('id="tab-dreams"')
    expect(html).toContain('id="view-dreams"')
    const m = html.match(/<script id="kb-dreams">([\s\S]*?)<\/script>/)
    expect(m).not.toBeNull()
    const body = m![1]!
    expect(body).toContain("apiUrl('/knowledge/dreams')") // fetches the audit trail
    expect(body).toContain('function loadDreams')
    expect(body).toContain('window.__loadDreams') // exposed for the tab switcher
    // Parse-only guard against a syntax error breaking the dashboard.
    expect(() => new Function(body)).not.toThrow()
  })

  test('U-UI-07: nodes render as a soft additive glow (fuzzy light, not a hard disc)', () => {
    const html = generateDashboardHtml()
    const body = html.match(/<script id="kb-graph">([\s\S]*?)<\/script>/)![1]!
    // A radial gradient fading to transparent, painted additively so glows bloom.
    expect(body).toContain('createRadialGradient')
    expect(body).toContain("globalCompositeOperation = 'lighter'")
    expect(body).toContain("addColorStop(1, 'rgba(0,0,0,0)')")
  })

  test('U-UI-08: the Logout button is grouped beside the auto-refresh indicator', () => {
    const html = generateDashboardHtml()
    // Both live in the same top-right cluster (Logout, then the refresh status).
    const cluster = html.match(/<span id="top-right">([\s\S]*?)<\/span><\/h1>/)
    expect(cluster).not.toBeNull()
    expect(cluster![1]).toContain('id="logout-btn"')
    expect(cluster![1]).toContain('id="refresh-indicator"')
    // The old float:right inline style on the button is gone (styled via CSS now).
    expect(html).not.toContain('<button id="logout-btn" style="float:right')
  })

  test('U-UI-09: node type colours cover real memory types + a distinct hash fallback', () => {
    const html = generateDashboardHtml()
    const body = html.match(/<script id="kb-graph">([\s\S]*?)<\/script>/)![1]!
    // The real memory vocabulary (user/feedback/project/reference) — the bug was a
    // KB ontology (decision/evidence…) that matched nothing, so all tags went grey.
    expect(body).toContain('feedback:')
    expect(body).toContain('project:')
    expect(body).toContain('reference:')
    // Any unlisted type still gets its own stable colour (no single-grey collapse).
    expect(body).toContain('function hashHue')
    expect(body).toContain("'hsl(' + hashHue(type)")
  })

  test('U-UI-10: the note detail is a full-width Markdown section below the graph (no floating panel)', () => {
    const html = generateDashboardHtml()
    // Full-width note section replaces the old floating side panel.
    expect(html).toContain('id="kb-note"')
    expect(html).not.toContain('id="kb-panel"')
    const body = html.match(/<script id="kb-graph">([\s\S]*?)<\/script>/)![1]!
    // It fetches the WHOLE file and renders it as Markdown (no truncation).
    expect(body).toContain("apiUrl('/knowledge/note')")
    expect(body).toContain('function renderMarkdown')
    expect(body).toContain('function showNote')
    // XSS-safe: builds DOM via textContent and blocks javascript: hrefs.
    expect(body).toContain('function sanitizeHref')
    expect(body).not.toContain('innerHTML')
    // The emitted script must be syntactically valid (doubled-backslash regex trap).
    expect(() => new Function(body)).not.toThrow()
  })

  test('U-UI-12: note header shows the file path + last-modified date', () => {
    const html = generateDashboardHtml()
    const body = html.match(/<script id="kb-graph">([\s\S]*?)<\/script>/)![1]!
    // A full-path line (populated from the endpoint) and an "updated" date chip.
    expect(html).toContain('kb-note-path')
    expect(body).toContain('kb-note-path')
    expect(body).toContain("chip('updated'")
    // Both come from the backend note payload, not the graph node.
    expect(body).toContain('data.path')
    expect(body).toContain('data.updated')
    expect(() => new Function(body)).not.toThrow()
  })

  test('U-UI-13: Markdown renderer supports tables, nested lists, task boxes, strikethrough', () => {
    const body = generateDashboardHtml().match(/<script id="kb-graph">([\s\S]*?)<\/script>/)![1]!
    // GFM pipe tables (wrapped for horizontal scroll).
    expect(body).toContain('kb-table-wrap')
    expect(body).toContain('function tableCells')
    // Indent-nested lists via a stack (not the old flat single-list).
    expect(body).toContain('function listTarget')
    expect(body).not.toContain('listOrdered') // old flat-list state is gone
    // Task-list checkboxes and strikethrough.
    expect(body).toContain('kb-task')
    expect(body).toContain("el('del'")
    // Still XSS-safe — DOM built via textContent, never innerHTML.
    expect(body).not.toContain('innerHTML')
    expect(() => new Function(body)).not.toThrow()
  })

  test('U-UI-04: input-mode wiring references the shared send path', () => {
    const body = scriptBody(generateDashboardHtml())
    expect(body).toContain('setPtyInputMode')
    expect(body).toContain('term.onData')
    expect(body).toContain('Interactive Terminal') // title in input mode
  })

  test('U-UI-05: physical PageUp/PageDown keys are forwarded to the PTY in view mode', () => {
    const html = generateDashboardHtml()
    // No on-screen page buttons — paging is driven by the real keyboard keys.
    expect(html).not.toContain('id="pty-pageup-btn"')
    expect(html).not.toContain('id="pty-pagedown-btn"')
    const body = scriptBody(html)
    // A keydown handler forwards ONLY PageUp/PageDown (5~ / 6~), never printable
    // input, and skips input mode (xterm.onData already sends them there).
    expect(body).toContain('function forwardPageKey')
    expect(body).toContain("e.key !== 'PageUp'")
    expect(body).toContain("e.key !== 'PageDown'")
    expect(body).toContain('if (ptyInputMode) return') // no double-send in input mode
    expect(body).toContain('[5~') // PageUp
    expect(body).toContain('[6~') // PageDown
  })

  test('U-UI-05b: the page-key listener is on document, not the viewer container (regression)', () => {
    // Regression guard for Issue #201: the handler was originally attached to the
    // #pty-terminal container, which only fires while that element holds focus —
    // and with disableStdin xterm rarely does, so a reconnect or stray click left
    // PageUp/PageDown dead. Verified end-to-end (headless Chromium) that a
    // document-level listener delivers the keys with focus OUTSIDE the terminal.
    const body = scriptBody(generateDashboardHtml())
    expect(body).toContain("document.addEventListener('keydown', forwardPageKey)")
    // Must NOT be re-scoped back to the focus-dependent container.
    expect(body).not.toContain(
      "document.getElementById('pty-terminal').addEventListener('keydown', forwardPageKey)",
    )
    // The handler self-gates on the viewer being open (so it is harmless page-wide).
    expect(body).toContain("getElementById('pty-viewer')")
  })
})
