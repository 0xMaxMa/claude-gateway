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

test('nightly reports use local midnight, including last night in UTC',()=>{
 const now=Date.parse('2026-09-19T01:00:00Z');
 const since=dashboardSince('24h',now,'Asia/Bangkok');
 expect(since).toBe(Date.parse('2026-09-18T17:00:00Z'));
 expect(Date.parse('2026-09-18T20:09:30Z')).toBeGreaterThan(since);
 expect(dashboardSince('7d',Date.parse('2026-03-10T12:00:00Z'),'America/New_York')).toBe(Date.parse('2026-03-04T05:00:00Z'));
 expect(dashboardSince('24h',Date.parse('2026-03-10T12:00:00Z'),'America/New_York')).toBe(Date.parse('2026-03-10T04:00:00Z'));
});
