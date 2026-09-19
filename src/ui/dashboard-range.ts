/** Calendar windows include today, starting at 00:00 in the configured timezone (UTC by default). */
export function dashboardRange(value: unknown): string {
 return typeof value === 'string' && ['24h','7d','30d','90d','all'].includes(value) ? value : '24h';
}
export function dashboardSince(value: unknown, now = Date.now(), timezone = 'UTC'): number {
 const range = dashboardRange(value);
 if (range === 'all') return 0;
 const days = range === '24h' ? 1 : Number(range.slice(0,-1));
 const parts = new Intl.DateTimeFormat('en-CA', {timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(now);
 const part=(name:string)=>Number(parts.find(p=>p.type===name)!.value);
 const target=Date.UTC(part('year'),part('month')-1,part('day')-(days-1));
 // Resolve midnight in the configured zone, including changes in UTC offset.
 let instant=target;
 const clock=new Intl.DateTimeFormat('en-GB',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});
 for(let i=0;i<4;i++){
   const values=clock.formatToParts(instant);
   const v=(name:string)=>Number(values.find(p=>p.type===name)!.value);
   const local=Date.UTC(v('year'),v('month')-1,v('day'),v('hour'),v('minute'),v('second'));
   const next=instant+target-local;
   if(next===instant)break;
   instant=next;
 }
 return instant;
}
export function rangeButtons(id: string, selected: string, timezone = 'UTC'): string {
 timezone=timezone.replace(/[^A-Za-z0-9_+\/.-]/g,'');
 return '<div id="'+id+'" class="range-toggle" role="group" aria-label="Date range, from midnight '+timezone+'">'+['24h','7d','30d','90d','all'].map(value=>'<button type="button" data-range="'+value+'" aria-pressed="'+(value===selected)+'" title="'+(value==='24h'?'Today from 00:00 '+timezone:value==='all'?'All recorded history':value+' including today, from 00:00 '+timezone)+'">'+value+'</button>').join('')+'</div>';
}
