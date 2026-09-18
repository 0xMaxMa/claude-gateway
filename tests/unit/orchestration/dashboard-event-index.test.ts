import { OrchestrationStore } from '../../../src/orchestration/store';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

test('existing databases index latest task tools without scanning or sorting event history', () => {
  const root = mkdtempSync(join(tmpdir(), 'dashboard-event-index-'));
  let store = new OrchestrationStore(join(root, 'orchestration.db'), 'agent');
  try {
    const input = store.acceptInput({scope:{agentId:'agent',agentSessionId:'session',source:'api',accountId:'owner',principalId:'owner',chatId:'chat',threadKey:''},text:'hello'});
    store.transaction(() => {
      for (let i=0;i<100;i++) store.appendEvent(input.conversationId, 'tool.activity', {name:'Tool'+i}, i % 2 ? 'other' : 'target');
      store.appendEvent(input.conversationId, 'task.updated', {name:'Not a tool'}, 'target');
    });
    // Simulate an existing database created before this index was introduced.
    store.run('DROP INDEX conversation_events_task_tool');
    store.close();
    store = new OrchestrationStore(join(root,'orchestration.db'), 'agent');
    const sql = "SELECT payload_json FROM conversation_events WHERE json_extract(payload_json,'$.task_id')=? AND type='tool.activity' ORDER BY seq DESC LIMIT 1";
    expect(JSON.parse(String(store.get(sql,'target')!.payload_json)).payload.name).toBe('Tool98');
    const plan = store.all('EXPLAIN QUERY PLAN '+sql, 'target').map(row=>String(row.detail)).join('\n');
    expect(plan).toContain('USING INDEX conversation_events_task_tool');
    expect(plan).not.toMatch(/SCAN conversation_events|TEMP B-TREE/);
    store.close();
    store = new OrchestrationStore(join(root,'orchestration.db'), 'agent');
    expect(store.get(sql,'target')).toBeDefined();
  } finally {store.close();rmSync(root,{recursive:true,force:true});}
});
