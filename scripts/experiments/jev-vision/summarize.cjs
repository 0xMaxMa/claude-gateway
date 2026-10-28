// Summarize harness JSONL files per variant and per action type: node summarize.cjs f114.jsonl [f113.jsonl …]
const fs = require('fs');
const rows = process.argv.slice(2).flatMap(f => fs.readFileSync(f, 'utf8').trim().split('\n').map(l => JSON.parse(l)).map(r => ({ ...r, file: f })));
const q = (xs, p) => { if (!xs.length) return '-'; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const pct = (a, b) => b ? `${a}/${b} (${Math.round(100 * a / b)}%)` : '-';
const PRICE = 0.042 / 1e6;
const tasks = rows.filter(r => r.type === 'task'), steps = rows.filter(r => r.type === 'step');
const name = r => `${r.variant}@${tasks.find(t => t.file === r.file)?.model}`;
const SUBMIT = ['form-search', 'icon-search', 'type-th-search', 'type-enter-only'], NO_SUBMIT = ['type-no-submit'];

for (const v of [...new Set(tasks.map(name))]) {
  const ts = tasks.filter(t => name(t) === v), ss = steps.filter(s => name(s) === v);
  const ok = ts.filter(t => t.success).length, calls = ss.filter(s => !s.error);
  console.log(`\n## ${v}: ${pct(ok, ts.length)} tasks`);
  const kinds = [...new Set(ts.map(t => t.kind))];
  console.log('- by scenario kind: ' + kinds.map(k => { const kt = ts.filter(t => t.kind === k); return `${k} ${kt.filter(t => t.success).length}/${kt.length}`; }).join(', '));
  const ms = calls.map(s => s.ms), tok = calls.map(s => s.usage.input_tokens), zooms = calls.filter(s => s.zoom).map(s => s.zoom);
  console.log(`- Jev step call ms p50/p95 ${q(ms, .5)}/${q(ms, .95)} (n=${ms.length}); task ms p50/p95 ${q(ts.map(t => t.ms), .5)}/${q(ts.map(t => t.ms), .95)}; steps/task ${(ts.reduce((n, t) => n + t.steps, 0) / ts.length).toFixed(1)}`);
  if (zooms.length) console.log(`- zoom+dot per click: ms p50/p95 ${q(zooms.map(z => z.ms), .5)}/${q(zooms.map(z => z.ms), .95)}, tokens avg ${Math.round(zooms.reduce((n, z) => n + z.tokens, 0) / zooms.length)}; dot refused ${zooms.filter(z => z.dot < 0.5).length}/${zooms.length}`);
  const allTok = ts.reduce((n, t) => n + t.tokens, 0);
  console.log(`- request bytes p50/max ${q(calls.map(s => s.bytes), .5)}/${Math.max(...calls.map(s => s.bytes))}; input tokens/step p50 ${q(tok, .5)}; cost/task ≈ $${(allTok * PRICE / ts.length).toFixed(5)} (${Math.round(allTok / ts.length)} tokens)`);
  console.log(`- wrong clicks ${ts.reduce((n, t) => n + t.wrong.length, 0)} in ${ts.filter(t => t.wrong.length).length} tasks; false confirmations (non-safety) ${ts.filter(t => t.kind !== 'safety').reduce((n, t) => n + t.confirmations, 0)}; errors ${ts.filter(t => t.outcome === 'error').length}; outcomes ${JSON.stringify(ts.reduce((m, t) => (m[t.outcome] = (m[t.outcome] ?? 0) + 1, m), {}))}`);
  const mism = calls.filter(s => s.mismatch).length; if (mism) console.log(`- choice≠rounded argmax (tolerated ≤0.01): ${mism}/${calls.length} calls`);
  // Per executed action type
  const exec = calls.filter(s => s.did !== undefined), kindOf = s => s.decision.kind === 'confirm' ? s.decision.action.kind : s.decision.kind;
  const byOp = {}; for (const s of exec) (byOp[kindOf(s)] ??= []).push(s);
  console.log('- per action executed (count, Jev ms p50/p95): ' + Object.entries(byOp).map(([k, xs]) => `${k} ${xs.length} (${q(xs.map(x => x.ms), .5)}/${q(xs.map(x => x.ms), .95)})`).join(', '));
  const clicks = (byOp.click ?? []).filter(s => s.did !== 'refused');
  const right = clicks.filter(s => s.hit.some(k => !k.startsWith('x'))).length, wrongC = clicks.filter(s => s.hit.some(k => k.startsWith('x'))).length;
  console.log(`- click: on target ${pct(right, clicks.length)}, on wrong control ${wrongC}, on nothing ${clicks.length - right - wrongC}; via box ${clicks.filter(s => (s.decision.action ?? s.decision).source === 'box').length}, via element ${clicks.filter(s => (s.decision.action ?? s.decision).source === 'element').length}`);
  const types = byOp.type ?? [];
  const typeTasks = ts.filter(t => t.kind === 'type');
  console.log(`- type: ${types.length} typing steps, field via box ${types.filter(s => (s.decision.action ?? s.decision).source === 'box').length} / element ${types.filter(s => (s.decision.action ?? s.decision).source === 'element').length}; text = verbatim goal candidate (no generation); typing tasks ${pct(typeTasks.filter(t => t.success).length, typeTasks.length)}; submit-needed ${pct(ts.filter(t => SUBMIT.includes(t.scenario) && t.success).length, ts.filter(t => SUBMIT.includes(t.scenario)).length)}; must-not-submit ${pct(ts.filter(t => NO_SUBMIT.includes(t.scenario) && t.success).length, ts.filter(t => NO_SUBMIT.includes(t.scenario)).length)}; NO_TEXT give-ups ${calls.filter(s => s.decision.reason === 'NO_TEXT').length}`);
  const scrolls = byOp.scroll ?? [], judged = scrolls.filter(s => s.place === 'above' || s.place === 'below');
  const dirOk = judged.filter(s => (s.place === 'below') === (s.decision.direction === 'down')).length;
  const overScroll = scrolls.filter(s => s.place === 'visible').length;
  const reversals = ts.filter(t => { const dirs = ss.filter(s => s.scenario === t.scenario && s.decision?.kind === 'scroll').map(s => s.decision.direction); return dirs.some((d, i) => i && d !== dirs[i - 1]); }).length;
  const scrollTasks = ts.filter(t => t.kind === 'scroll');
  console.log(`- scroll: direction right ${pct(dirOk, judged.length)}; scrolled although target visible ${overScroll}; tasks with direction flip-flop ${reversals}; amounts ${JSON.stringify(scrolls.reduce((m, s) => (m[s.decision.amount] = (m[s.decision.amount] ?? 0) + 1, m), {}))}; scroll tasks ${pct(scrollTasks.filter(t => t.success).length, scrollTasks.length)}`);
  const keys = byOp.key ?? [], keyTasks = ts.filter(t => t.kind === 'key');
  console.log(`- key: ${keys.map(s => `${s.decision.key ?? s.decision.action?.key}x${s.decision.count ?? s.decision.action?.count}`).join(' ')}; key tasks ${pct(keyTasks.filter(t => t.success).length, keyTasks.length)}`);
  const navTasks = ts.filter(t => t.kind === 'navigate');
  console.log(`- navigate/back: ${(byOp.navigate ?? []).length} navigate, ${(byOp.back ?? []).length} back steps; tasks ${pct(navTasks.filter(t => t.success).length, navTasks.length)}`);
  // Done detection over every step of "complete" tasks
  const judgedDone = ss.filter(s => !s.error && s.goalMet !== undefined && tasks.find(t => t.file === s.file && t.scenario === s.scenario && t.variant === s.variant)?.expect === 'complete');
  const met = judgedDone.filter(s => s.goalMet), notMet = judgedDone.filter(s => !s.goalMet);
  console.log(`- done: stopped when goal met ${pct(met.filter(s => s.decision.kind === 'done').length, met.length)}; false "done" before goal met ${pct(notMet.filter(s => s.decision.kind === 'done').length, notMet.length)} steps; done-already tasks ${pct(ts.filter(t => t.kind === 'done' && t.success).length, ts.filter(t => t.kind === 'done').length)}; give-up when target absent ${pct(ts.filter(t => t.kind === 'give_up' && t.success).length, ts.filter(t => t.kind === 'give_up').length)}; safety confirm ${pct(ts.filter(t => t.kind === 'safety' && t.success).length, ts.filter(t => t.kind === 'safety').length)}`);
  console.log('- failed: ' + ts.filter(t => !t.success).map(t => `${t.scenario}(${t.outcome}${t.wrong.length ? ' wrong=' + t.wrong.join('|') : ''})`).join(', '));
}
