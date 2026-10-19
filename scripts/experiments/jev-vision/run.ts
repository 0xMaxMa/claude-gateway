/**
 * Image-first Jev experiment harness. Runs every scenario under one or more variants in
 * headless Chromium and writes one JSON line per step and per task. Usage (after bundling):
 *   JEV_API_KEY=… node run.cjs --variants text,image,image-zoom,hybrid-zoom --model jev-1.14.0 --out results.jsonl [--only id,id]
 * "-zoom" adds the crop refine and dot check to every Box click. The key is read from the
 * environment only and never logged. Fixture pages are served at http://lab.test/ by route
 * interception; nothing leaves the machine except the Jev requests.
 */
import { appendFileSync } from 'node:fs';
import { chromium, type Page } from 'playwright-core';
import { JevService } from '../../../src/jev/service';
import { JevError, type JevConfig } from '../../../src/jev/types';
import { SCROLL_AMOUNTS, buildDotCheck, buildRefineStep, buildVisionStep, dotHits, readRefineStep, readVisionStep, refineCrop, type VisionAction, type VisionDecision, type VisionElement, type VisionVariant } from '../../../src/automation/jev-vision-step';
import { SCENARIOS, kindOf, type Scenario } from './scenarios';

const arg = (name: string, fallback: string) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : fallback; };
// "som" is the hybrid variant with Set-of-Mark ids drawn on the screenshot.
const variants = arg('variants', 'text,image,image-zoom,hybrid-zoom,som-zoom').split(',');
const model = arg('model', 'jev-1.14.0'), out = arg('out', 'results.jsonl'), only = arg('only', ''), maxSteps = Number(arg('steps', '10'));
const VIEW = { width: 1280, height: 800 }, ORIGIN = 'http://lab.test';
const config: JevConfig = { enabled: true, provider: 'typesafe', model, apiKeyEnv: 'JEV_API_KEY', timeoutMs: 30000, images: { enabled: true } };
const context = { principalId: 'jev-vision-lab', consumer: 'experiment' };
const jev = new JevService({ getConfig: () => config });
const log = (row: Record<string, unknown>) => appendFileSync(out, JSON.stringify(row) + '\n');
const KEY_NAMES: Record<string, string> = { ENTER: 'Enter', TAB: 'Tab', SHIFT_TAB: 'Shift+Tab', ESCAPE: 'Escape', BACKSPACE: 'Backspace', DELETE: 'Delete', ARROW_UP: 'ArrowUp', ARROW_DOWN: 'ArrowDown', ARROW_LEFT: 'ArrowLeft', ARROW_RIGHT: 'ArrowRight', SPACE: 'Space' };

/** Interactive controls the DOM exposes, as today's text-only worker sees them. Icon buttons have no label. */
async function observe(page: Page): Promise<{ elements: VisionElement[]; text: string; title: string }> {
  return page.evaluate(() => {
    const els = [...document.querySelectorAll('button,a,input,textarea,select,[role=button],canvas')] as HTMLElement[];
    const elements = els.filter(e => { const s = getComputedStyle(e), r = e.getBoundingClientRect(); return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0; }).map((e, i) => {
      e.dataset.jv = `E${i}`;
      const input = e as HTMLInputElement, r = e.getBoundingClientRect();
      const labelled = input.id ? document.querySelector(`label[for="${input.id}"]`)?.textContent ?? '' : '';
      const label = (e.getAttribute('aria-label') || e.innerText || input.placeholder || labelled || e.title || '').trim();
      const role = e.tagName === 'INPUT' ? `input:${input.type}` : e.tagName.toLowerCase();
      const inView = r.bottom > 0 && r.top < innerHeight;
      return { id: `E${i}`, role, label, ...(inView ? {} : { context: 'off-screen; needs scrolling' }), ...(document.activeElement === e ? { context: 'focused' } : {}), ...(input.value && e.tagName !== 'BUTTON' ? { value: input.value } : {}), ...(input.type === 'checkbox' || input.type === 'radio' ? { checked: input.checked } : {}) };
    });
    return { elements, text: document.body.innerText.slice(0, 4000), title: document.title };
  });
}
/** Where the goal's control is relative to the viewport (or its scroll panel), for judging scroll steps. */
const targetPlace = (page: Page, selector: string) => page.evaluate(sel => {
  const e = document.querySelector(sel); if (!e) return 'missing';
  const r = e.getBoundingClientRect(), panel = e.closest('#panel')?.getBoundingClientRect();
  const top = Math.max(0, panel?.top ?? 0), bottom = Math.min(innerHeight, panel?.bottom ?? innerHeight);
  return r.bottom <= top ? 'above' : r.top >= bottom ? 'below' : 'visible';
}, selector);
/** Draw each observed element's id on the page (Set-of-Mark) for the next screenshot. */
const drawMarks = (page: Page) => page.evaluate(() => {
  const layer = document.createElement('div'); layer.id = '__marks'; layer.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:99998';
  for (const e of document.querySelectorAll<HTMLElement>('[data-jv]')) {
    const r = e.getBoundingClientRect(); if (r.bottom <= 0 || r.top >= innerHeight) continue;
    const m = document.createElement('div'); m.textContent = e.dataset.jv!;
    m.style.cssText = `position:absolute;left:${Math.max(0, r.left - 2)}px;top:${Math.max(0, r.top - 14)}px;font:bold 11px monospace;color:#fff;background:#c0f;padding:0 2px;border-radius:2px;outline:1px solid #c0f`;
    const b = document.createElement('div'); b.style.cssText = `position:absolute;left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px;outline:2px solid #c0f`;
    layer.append(b, m);
  }
  document.body.appendChild(layer);
});
const screenHash = async (page: Page) => (await import('node:crypto')).createHash('sha1').update(await page.screenshot({ type: 'png' })).digest('hex');
/** Which fixture control (data-k) a screen point lands on. */
const keyAt = (page: Page, x: number, y: number) => page.evaluate(([x, y]) => { const e = document.elementFromPoint(x, y); return (e?.closest('[data-k]') as HTMLElement | null)?.dataset.k ?? (e?.closest('input,textarea,label') ? 'field' : (e as HTMLElement | null)?.id === 'c' ? 'canvas' : 'none'); }, [x, y] as const);

async function act(page: Page, d: VisionAction): Promise<string> {
  switch (d.kind) {
    case 'scroll': {
      const at = d.at ?? { x: VIEW.width / 2, y: VIEW.height / 2 };
      await page.mouse.move(at.x, at.y); await page.mouse.wheel(0, (d.direction === 'down' ? 1 : -1) * Math.round(SCROLL_AMOUNTS[d.amount] * VIEW.height)); await page.waitForTimeout(200);
      return `scrolled ${d.direction} ${d.amount.toLowerCase()}`;
    }
    case 'key': for (let i = 0; i < d.count; i++) await page.keyboard.press(KEY_NAMES[d.key]); await page.waitForTimeout(150); return `pressed ${d.key} x${d.count}`;
    case 'back': await page.goBack({ waitUntil: 'load' }); return 'went back';
    case 'navigate': {
      // The harness only ever opens its own fixture origin.
      if (new URL(d.url).origin !== ORIGIN) return `refused to open ${d.url}`;
      await page.goto(d.url, { waitUntil: 'load' }); return `opened ${d.url}`;
    }
  }
  let where: string;
  if ('elementId' in d.at) {
    const el = page.locator(`[data-jv="${d.at.elementId}"]`);
    where = `${d.at.elementId} (${(await el.evaluate(e => (e as HTMLElement).innerText || (e as HTMLInputElement).placeholder || e.tagName).catch(() => '?')).slice(0, 40)})`;
    await el.click({ timeout: 3000 });
  } else {
    where = `screen point (${d.at.x}, ${d.at.y})`;
    await page.mouse.click(d.at.x, d.at.y);
  }
  if (d.kind === 'type') { await page.keyboard.press('Control+A'); await page.keyboard.insertText(d.text!); }
  await page.waitForTimeout(150);
  return d.kind === 'type' ? `typed ${JSON.stringify(d.text)} into ${where}` : `clicked ${where}`;
}

/** Crop refine, then a dot check on the refined point: point undefined means "do not click". */
async function zoomIn(page: Page, s: Scenario, history: string[], at: { x: number; y: number }, step: Record<string, unknown>) {
  const shot = async (crop: ReturnType<typeof refineCrop>) => ({ data: (await page.screenshot({ type: 'png', clip: crop })).toString('base64'), format: 'png' as const, width: crop.width, height: crop.height });
  const z0 = Date.now(), crop = refineCrop(at, VIEW);
  const refined = await jev.evaluate(buildRefineStep(s.goal, history, await shot(crop)), context);
  const point = readRefineStep(refined, crop) ?? at, dotCrop = refineCrop(point, VIEW);
  await page.evaluate(([x, y]) => { const d = document.createElement('div'); d.id = '__dot'; d.style.cssText = `position:fixed;left:${x - 6}px;top:${y - 6}px;width:12px;height:12px;border-radius:50%;background:#f00;border:2px solid #fff;box-shadow:0 0 0 1px #f00;pointer-events:none;z-index:99999`; document.body.appendChild(d); }, [point.x, point.y] as const);
  const dotShot = await shot(dotCrop);
  await page.evaluate(() => document.getElementById('__dot')?.remove());
  const dot = await jev.evaluate(buildDotCheck(s.goal, history, dotShot), context);
  const hit = dotHits(dot), tokens = refined.usage.input_tokens + dot.usage.input_tokens;
  step.zoom = { ms: Date.now() - z0, tokens, from: at, to: point, key: await keyAt(page, point.x, point.y), dot: (dot.answers.hit as { noul: number }).noul };
  return { point: hit ? point : undefined, tokens };
}

const clicksNow = (page: Page): Promise<string[]> => page.evaluate(() => (window as any).__clicks?.slice() ?? []);

async function runTask(page: Page, s: Scenario, name: string) {
  const base = name.split('-')[0], variant = (base === 'som' ? 'hybrid' : base) as VisionVariant, marks = base === 'som', zoom = name.endsWith('-zoom'), kind = kindOf(s);
  const pages: Record<string, string> = { '/': s.html, ...s.pages };
  await page.route(`${ORIGIN}/**`, route => { const html = pages[new URL(route.request().url()).pathname]; return html ? route.fulfill({ contentType: 'text/html; charset=utf-8', body: html }) : route.fulfill({ status: 404, body: 'not found' }); });
  for (const path of s.visited ?? ['/']) await page.goto(ORIGIN + path, { waitUntil: 'load' });
  await page.waitForTimeout(100);
  const history: string[] = [], started = Date.now();
  let outcome = 'max_steps', steps = 0, error: string | undefined, tokens = 0, confirmations = 0, refusals = 0;
  for (; steps < maxSteps; steps++) {
    const goalMet = await page.evaluate(s.check).catch(() => false) === true;
    const place = s.target ? await targetPlace(page, s.target) : undefined;
    const seen = await observe(page);
    if (marks) await drawMarks(page);
    const shot = variant === 'text' ? undefined : await page.screenshot({ type: 'png' });
    if (marks) await page.evaluate(() => document.getElementById('__marks')?.remove());
    const before = { url: page.url(), title: seen.title, hash: await screenHash(page) };
    const input = { variant, marks, goal: s.goal, history, page: { url: page.url(), title: seen.title, text: seen.text }, elements: seen.elements, ...(shot ? { screenshot: { data: shot.toString('base64'), format: 'png' as const, ...VIEW } } : {}) };
    const request = buildVisionStep(input);
    const bytes = Buffer.byteLength(JSON.stringify({ model, ...request }));
    const clicksBefore = await clicksNow(page);
    const t0 = Date.now();
    try {
      const result = await jev.evaluate(request, context);
      const ms = Date.now() - t0;
      const decision: VisionDecision = readVisionStep(input, result);
      tokens += result.usage.input_tokens;
      const a = result.answers as Record<string, any>;
      // Choices whose named answer is not the top probability (accepted within 0.01, counted here).
      const mismatch = Object.entries(a).filter(([, q]) => q.type === 'choice' && Object.values(q.probabilities as Record<string, number>).some(v => v > q.probabilities[q.choice])).map(([id]) => id);
      const step: Record<string, unknown> = { type: 'step', scenario: s.id, group: s.group, kind, variant: name, model: result.model, step: steps, ms, bytes, imageBytes: shot?.length ?? 0, usage: result.usage, decision, goalMet, place,
        op: a.op?.choice, opConf: a.op?.confidence, done: a.done?.noul, visible: a.visible?.noul, box: a.target?.box, boxConf: a.target?.confidence, element: a.element?.choice, elementConf: a.element?.confidence,
        key: a.key?.choice, count: a.count?.choice, scroll: a.scroll?.choice, amount: a.amount?.choice, text: a.text?.choice, impactHigh: a.impact?.probabilities?.HIGH_IMPACT, ...(mismatch.length ? { mismatch } : {}) };
      if (a.target?.box) step.boxKey = await keyAt(page, Math.round((a.target.box.left + a.target.box.right) / 2 * VIEW.width), Math.round((a.target.box.top + a.target.box.bottom) / 2 * VIEW.height));
      if (decision.kind === 'done' || decision.kind === 'give_up' || (decision.kind === 'confirm' && s.expect === 'confirm')) { log(step); outcome = decision.kind; steps++; break; }
      // Outside the safety scenarios a confirmation is a false alarm: count it, then act as if the user approved.
      if (decision.kind === 'confirm') confirmations++;
      let action = decision.kind === 'confirm' ? decision.action : decision;
      // Text fields are large and adjacent; zooming them lands between fields, so only clicks zoom.
      if (zoom && action.kind === 'click' && 'x' in action.at) {
        const z = await zoomIn(page, s, history, action.at, step);
        tokens += z.tokens;
        if (!z.point) { refusals++; history.push(`did not ${action.kind}: the pointer was not on the target`); log({ ...step, did: 'refused', hit: [] }); continue; }
        action = { ...action, at: z.point };
      }
      let did = await act(page, action).catch(e => `action failed: ${String(e.message).slice(0, 80)}`);
      // Evidence of what the step changed, available to computer use too (window title, pixels).
      const title = await page.title().catch(() => '');
      if (page.url() !== before.url || title !== before.title) did += `; now on "${title}" (${page.url()})`;
      else if (await screenHash(page) === before.hash) did += '; the screen did not change';
      history.push(did);
      const clicksAfter = await clicksNow(page);
      log({ ...step, did, hit: clicksAfter.length >= clicksBefore.length ? clicksAfter.slice(clicksBefore.length) : clicksAfter, after: s.target ? await targetPlace(page, s.target) : undefined });
      // Three identical steps is a loop, except scrolls that keep moving the screen: those are progress.
      if (history.length >= 3 && history.slice(-3).every(h => h === did) && !(action.kind === 'scroll' && !did.endsWith('did not change'))) { outcome = 'stuck'; steps++; break; }
    } catch (e) {
      error = e instanceof JevError ? `${e.code}${e.metadata?.status ? ' ' + e.metadata.status : ''}${e.metadata?.validationReason ? ' ' + e.metadata.validationReason : ''}` : String((e as Error).message).slice(0, 120);
      log({ type: 'step', scenario: s.id, group: s.group, kind, variant: name, step: steps, ms: Date.now() - t0, bytes, error });
      outcome = 'error'; steps++; break;
    }
  }
  const checked = await page.evaluate(s.check).catch(() => false) === true;
  const wrong = (await clicksNow(page)).filter(k => k.startsWith('x'));
  const success = s.expect === 'complete' ? checked && wrong.length === 0 && outcome !== 'error' : outcome === (s.expect === 'confirm' ? 'confirm' : 'give_up') && wrong.length === 0;
  log({ type: 'task', scenario: s.id, group: s.group, kind, variant: name, model, expect: s.expect, outcome, checked, success, wrong, confirmations, refusals, steps, ms: Date.now() - started, tokens, error, history });
  console.log(`${name.padEnd(12)} ${s.id.padEnd(16)} ${success ? 'OK  ' : 'FAIL'} ${outcome} steps=${steps} wrong=${wrong.join('|') || '-'}${error ? ' err=' + error : ''}`);
}

(async () => {
  const browser = await chromium.launch();
  // --pairs variant:scenario,… reruns chosen tasks only (e.g. those ended by a transient provider error).
  const pairs = arg('pairs', '').split(',').filter(Boolean);
  for (const s of SCENARIOS.filter(s => !only || only.split(',').includes(s.id)))
    for (const v of variants.filter(v => !pairs.length || pairs.includes(`${v}:${s.id}`)).concat(pairs.length ? [...new Set(pairs.filter(p => p.endsWith(`:${s.id}`)).map(p => p.split(':')[0]))].filter(v => !variants.includes(v)) : [])) {
      // A fresh page per task: a reused page keeps the previous fixture's listeners and history.
      const page = await browser.newPage({ viewport: VIEW, deviceScaleFactor: 1 });
      await runTask(page, s, v).catch(e => console.error(`${v} ${s.id} harness error: ${String(e?.message ?? e).slice(0, 160)}`));
      await page.close();
    }
  await browser.close();
})().catch(e => { console.error(String(e?.message ?? e)); process.exit(1); });
