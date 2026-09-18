/** Calendar windows include today, starting at 00:00 UTC. */
export function dashboardRange(value: unknown): string {
 return typeof value === 'string' && ['24h','7d','30d','90d','all'].includes(value) ? value : '24h';
}
export function dashboardSince(value: unknown, now = Date.now()): number {
 const range = dashboardRange(value);
 if (range === 'all') return 0;
 const days = range === '24h' ? 1 : Number(range.slice(0,-1));
 return Math.floor(now / 86400000) * 86400000 - (days - 1) * 86400000;
}
export function rangeButtons(id: string, selected: string): string {
 return '<div id="'+id+'" class="range-toggle" role="group" aria-label="Date range, from midnight UTC">'+['24h','7d','30d','90d','all'].map(value=>'<button type="button" data-range="'+value+'" aria-pressed="'+(value===selected)+'" title="'+(value==='24h'?'Today from 00:00 UTC':value==='all'?'All recorded history':value+' including today, from 00:00 UTC')+'">'+value+'</button>').join('')+'</div>';
}
