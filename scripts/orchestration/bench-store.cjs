#!/usr/bin/env node
// Local durability latency, not a provider/model/network performance claim.
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { performance } = require('node:perf_hooks');
const { OrchestrationStore } = require('../../dist/orchestration/store');
const { DecisionService } = require('../../dist/orchestration/decisions');
const { TaskService } = require('../../dist/orchestration/tasks/service');
const root = mkdtempSync(join(tmpdir(), 'orchestration-bench-'));
const store = new OrchestrationStore(join(root, 'orchestration.db'), 'fixture');
const decisions = new DecisionService(store), tasks = new TaskService(store, { tasks: { maxQueuedPerAgent: 1000, maxQueuedPerConversation: 1000 } });
const inputTimes = [], commandTimes = [];
const scope = { agentId: 'fixture', agentSessionId: 'agentSession', source: 'api', accountId: 'key', chatId: 'chat', threadKey: '', principalId: 'owner' };
try {
  for (let i = 0; i < 200; i++) {
    let start = performance.now();
    const receipt = store.acceptInput({ scope, text: `Task ${i}`, ingressKey: String(i) });
    inputTimes.push(performance.now() - start);
    const decision = decisions.begin(receipt.conversationId, 'owner', [receipt.inputId]);
    start = performance.now();
    tasks.spawn({ ...receipt, ...decision, principalId: 'owner', actionId: `action-${i}`, execute: true, writeMemory: false }, { title: `Task ${i}`, targetProfile: 'default-worker', instructions: 'Do the fixture task' });
    commandTimes.push(performance.now() - start);
    decisions.finish(decision, 'Queued.');
  }
  const summarize = values => { values.sort((a,b) => a-b); return { n: values.length, p50Ms: values[Math.floor(values.length * .50)], p95Ms: values[Math.floor(values.length * .95)], maxMs: values.at(-1) }; };
  const input = summarize(inputTimes), command = summarize(commandTimes);
  console.log(JSON.stringify({ node: process.version, platform: process.platform, sqlite: 'WAL, synchronous=FULL', input, command, pass: input.p95Ms <= 250 && command.p95Ms <= 250 }, null, 2));
  process.exitCode = input.p95Ms <= 250 && command.p95Ms <= 250 ? 0 : 1;
} finally { store.close(); rmSync(root, { recursive: true, force: true }); }
