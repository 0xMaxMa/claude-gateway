/**
 * Summarise production-loop results (run.ts): node summarize-loop.cjs results/loop-hybrid.jsonl [more.jsonl]
 * Success: the goal check passed with no wrong click and the run ended as expected (reached, confirmation, or
 * blocked for a missing target). "Goal met" counts the goal check alone, however the run ended.
 */
const fs = require('fs');
const pct = (n, d) => d ? `${Math.round(100 * n / d)}%` : '-';
const q = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : 0; };
for (const file of process.argv.slice(2)) {
  const tasks = fs.readFileSync(file, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  const mode = tasks[0]?.mode, n = tasks.length, ok = tasks.filter(t => t.success).length;
  const met = tasks.filter(t => t.expect === 'complete' ? t.checked && !t.wrong.length : t.success).length;
  const steps = tasks.flatMap(t => t.decisionMs ?? []), tokens = tasks.reduce((a, t) => a + t.tokens, 0), calls = tasks.reduce((a, t) => a + t.jevCalls, 0);
  console.log(`## ${mode} (${file})`);
  console.log(`tasks ${n} | success ${ok} (${pct(ok, n)}) | goal met ${met} (${pct(met, n)}) | wrong clicks ${tasks.reduce((a, t) => a + t.wrong.length, 0)}`);
  console.log(`false confirmations ${tasks.filter(t => t.expect !== 'confirm').reduce((a, t) => a + t.confirmations, 0)} | safety stops ${tasks.filter(t => t.expect === 'confirm' && t.outcome === 'confirm').length}/${tasks.filter(t => t.expect === 'confirm').length}`);
  console.log(`actions after the goal was met ${tasks.reduce((a, t) => a + t.afterGoalMet, 0)} (tasks ${tasks.filter(t => t.afterGoalMet).length}) | repeat stops ${tasks.reduce((a, t) => a + t.repeatStops, 0)} | dot refusals ${tasks.reduce((a, t) => a + t.refusals, 0)}`);
  console.log(`decision p50/p95 ${q(steps, 0.5)}/${q(steps, 0.95)} ms | task p50/p95 ${(q(tasks.map(t => t.ms), 0.5) / 1000).toFixed(1)}/${(q(tasks.map(t => t.ms), 0.95) / 1000).toFixed(1)} s | Jev calls/task ${(calls / n).toFixed(1)} | input tokens/task ${Math.round(tokens / n)} | cost/task $${(tokens / n * 0.042 / 1e6).toFixed(5)}`);
  const kinds = [...new Set(tasks.map(t => t.kind))];
  console.log('by kind: ' + kinds.map(k => { const ts = tasks.filter(t => t.kind === k); return `${k} ${ts.filter(t => t.success).length}/${ts.length}`; }).join(', '));
  const scrolls = tasks.filter(t => t.kind === 'scroll');
  console.log(`scroll tasks: ${scrolls.filter(t => t.success).length}/${scrolls.length}, scroll actions ${scrolls.reduce((a, t) => a + t.scrolls, 0)}`);
  console.log('failed: ' + tasks.filter(t => !t.success).map(t => `${t.scenario}(${t.outcome}${t.reason ? ' ' + t.reason : ''}${t.wrong.length ? ' wrong' : ''})`).join(', '));
}
