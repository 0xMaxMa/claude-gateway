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
