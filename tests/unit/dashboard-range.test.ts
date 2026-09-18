import {dashboardRange,dashboardSince,rangeButtons} from '../../src/ui/dashboard-range';
test('date windows start at midnight UTC and include today',()=>{
 const now=Date.parse('2026-09-17T18:23:45Z');
 expect(dashboardSince('24h',now)).toBe(Date.parse('2026-09-17T00:00:00Z'));
 expect(dashboardSince('7d',now)).toBe(Date.parse('2026-09-11T00:00:00Z'));
 expect(dashboardSince('30d',now)).toBe(Date.parse('2026-08-19T00:00:00Z'));
 expect(dashboardSince('90d',now)).toBe(Date.parse('2026-06-20T00:00:00Z'));
 expect(dashboardSince('all',now)).toBe(0);
 expect(dashboardSince(undefined,now)).toBe(dashboardSince('24h',now));
 expect(dashboardRange('current')).toBe('24h');
 const html=rangeButtons('range','7d');
 expect(html).toContain('data-range="7d" aria-pressed="true"');
 expect(html.match(/<button /g)).toHaveLength(5);
});

import {taskStatusBadge} from '../../src/ui/dashboard-presentation';
test('each task lifecycle status has a distinct color',()=>{
 const states=['queued','starting','running','waiting_input','interrupting','cancel_requested','recovering','needs_reconciliation','completed','failed','cancelled'];
 const colors=states.map(state=>taskStatusBadge(state).match(/--status-color:([^";]+)/)![1]);
 expect(new Set(colors).size).toBe(states.length);
});
