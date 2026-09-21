#!/usr/bin/env node
/*
 * Explicit paid smoke test against TypeSafe, using only a loopback fixture browser page.
 * npm run build
 * JEV_API_KEY=... PLAYWRIGHT_MODULE=playwright node scripts/jev-browser-smoke.cjs
 * Optional: JEV_SMOKE_TRIALS=1..3, JEV_SMOKE_REPORT=/path/report.json.
 * No extension/relay integration or parent-model baseline is tested here.
 */
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { JevService } = require('../dist/jev/service');
const { runBrowserTask } = require('../dist/jev/browser-runner');

async function main() {
  if (!process.env.JEV_API_KEY) throw Error('Set JEV_API_KEY to explicitly run this paid smoke test.');
  const trials = Number(process.env.JEV_SMOKE_TRIALS || 3);
  if (!Number.isInteger(trials) || trials < 1 || trials > 3) throw Error('JEV_SMOKE_TRIALS must be 1–3.');
  const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
  const report = {
    fixture: 'local confirmation button with server-side revision fence and independent receipt verification',
    provider: 'typesafe', requestedModel: 'jev-1.13.0', startedAt: new Date().toISOString(),
    liveVendor: true, productionBrowserIntegration: false, parentModelBaseline: null,
    trials: [],
  };
  const browser = await chromium.launch({ headless: true });
  try {
    for (let trial = 1; trial <= trials; trial++) {
      let revision = 0; let receipt = null; let granted = true;
      const nonce = randomUUID(); const calls = [];
      const server = http.createServer((req, res) => {
        if (req.method === 'GET' && req.url === '/') {
          res.setHeader('content-type', 'text/html');
          res.end(`<!doctype html><html><body><h1>Local confirmation fixture</h1><p id="status">Ready. Nothing has been confirmed.</p><button id="confirm">Confirm test action</button><script>
            document.querySelector('#confirm').onclick=async()=>{
              const response=await fetch('/confirm',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({nonce:${JSON.stringify(nonce)},revision:0})});
              if(!response.ok){document.querySelector('#status').textContent='Confirmation rejected';return;}
              const result=await response.json();document.querySelector('#status').textContent='Confirmed successfully. Receipt: '+result.receipt;
              document.querySelector('#status').dataset.receipt=result.receipt;document.querySelector('#confirm').remove();
            };
          </script></body></html>`);
          return;
        }
        if (req.method === 'POST' && req.url === '/confirm') {
          let body = '';
          req.on('data', chunk => { body += chunk; if (body.length > 1024) req.destroy(); });
          req.on('end', () => {
            let parsed; try { parsed = JSON.parse(body); } catch { res.writeHead(400).end(); return; }
            if (!granted || parsed.nonce !== nonce || parsed.revision !== revision || revision !== 0) { res.writeHead(409).end(); return; }
            revision++; receipt = randomUUID();
            res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ receipt }));
          });
          return;
        }
        res.writeHead(404).end();
      });
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      const origin = `http://127.0.0.1:${server.address().port}`;
      const page = await browser.newPage();
      await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
      const service = new JevService({
        getConfig: () => ({ enabled: true, provider: 'typesafe', model: report.requestedModel, apiKeyEnv: 'JEV_API_KEY', timeoutMs: 15000 }),
        onEvaluation: event => calls.push({ model: event.model, elapsedMs: event.elapsedMs, outcome: event.outcome, errorCode: event.errorCode, usage: event.usage }),
      });
      try {
        await page.goto(origin);
        const result = await runBrowserTask({
          goal: 'Click the Confirm test action button once and verify the confirmation receipt.',
          budget: { maxSteps: 2, maxEvaluations: 3, timeoutMs: 45000 },
          evaluate: (request, signal) => service.evaluate(request, { principalId: 'smoke-fixture', consumer: 'browser-smoke', signal, authorize: () => granted }),
          transport: {
            async observe(signal) {
              if (signal.aborted) throw Error('cancelled');
              const observed = await page.evaluate(() => ({ text: document.body.innerText, canConfirm: Boolean(document.querySelector('#confirm')) }));
              return { revision: String(revision), fingerprint: String(revision), state: observed.text, actions: observed.canConfirm ? [{ id: 'confirm-button', operation: 'click', description: 'Click the visible Confirm test action button' }] : [] };
            },
            async checkAccess(observation, action, signal) {
              return !signal.aborted && granted && observation.revision === String(revision) && (!action || (action.id === 'confirm-button' && revision === 0));
            },
            async execute({ observation, action }, signal) {
              if (signal.aborted || !granted || observation.revision !== String(revision) || action.id !== 'confirm-button') throw Error('stale_or_denied');
              // The fixture HTTP mutation independently checks ownership nonce and revision atomically.
              await page.locator('#confirm').click({ timeout: 3000 });
              await page.waitForFunction(() => Boolean(document.querySelector('#status')?.getAttribute('data-receipt')), undefined, { timeout: 3000 });
              return { outcome: 'applied' };
            },
            async verifyCompletion(observation, signal) {
              const browserReceipt = await page.locator('#status').getAttribute('data-receipt');
              const verified = !signal.aborted && granted && observation.revision === '1' && revision === 1 && receipt !== null && browserReceipt === receipt;
              return { verified, ...(verified ? { evidence: 'Independent fixture server confirms exactly one mutation and its receipt matches the current browser DOM.' } : {}) };
            },
          },
        });
        report.trials.push({ trial, ...result, independentConfirmedMutations: revision, calls });
      } finally {
        granted = false;
        await page.close();
        await new Promise(resolve => server.close(resolve));
      }
    }
  } finally { await browser.close(); }
  const calls = report.trials.flatMap(trial => trial.calls);
  const latencies = calls.map(call => call.elapsedMs).sort((a, b) => a - b);
  report.summary = {
    trials: report.trials.length,
    verifiedSuccesses: report.trials.filter(trial => trial.status === 'completed' && trial.independentConfirmedMutations === 1).length,
    vendorRequests: calls.length,
    reportedInputTokens: calls.reduce((sum, call) => sum + (call.usage?.input_tokens || 0), 0),
    reportedOutputTokens: calls.reduce((sum, call) => sum + (call.usage?.output_tokens || 0), 0),
    requestsWithUnknownUsage: calls.filter(call => !call.usage).length,
    medianCallMs: latencies.length ? (latencies[Math.floor((latencies.length - 1) / 2)] + latencies[Math.floor(latencies.length / 2)]) / 2 : null,
    maxCallMs: latencies.length ? latencies[latencies.length - 1] : null,
  };
  report.limitations = ['Small local fixture, not the production browser extension/relay.', 'No parent-model baseline: these measurements do not establish a speed or token improvement.', 'Reported tokens are measurements; no vendor price estimate or inferred cache usage is included.'];
  const destination = path.resolve(process.env.JEV_SMOKE_REPORT || 'jev-browser-smoke-report.json');
  await fs.writeFile(destination, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ report: destination, summary: report.summary }));
  if (report.summary.verifiedSuccesses !== trials) process.exitCode = 1;
}
main().catch(error => { console.error(error.code || error.name || 'SMOKE_FAILED'); process.exitCode = 1; });
