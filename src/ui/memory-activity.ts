/** Memory maintenance shares the dashboard theme, but owns its refresh and drawer state. */
export const memoryActivityHtml = String.raw`
<div class="heading"><h2>Nightly dreaming</h2><p>Completed compactions and memory reports, newest first.</p></div>
<div class="dash-grid" id="memory-stats"></div>
<div class="dash-filter" style="display:flex;flex-wrap:wrap;margin:20px 0">
<label>Agent <select id="memory-agent"><option value="">All agents</option></select></label>
<label>Activity <select id="memory-kind"><option value="all">All activities</option><option value="memory_dream">Memory dreams</option><option value="session_compaction" selected>Session compaction</option></select></label>
<label>Status <select id="memory-status"><option value="all">All statuses</option><option>pending</option><option>running</option><option>completed</option><option>failed</option><option value="partial_failure">partially failed</option><option>interrupted</option><option>skipped</option></select></label>
<button id="memory-refresh">Refresh</button><span class="live-note" id="memory-updated" role="status"></span>
</div>
<p class="live-note"><span id="memory-range-note">Uses the date range above.</span> Up to 100 recorded runs per activity per agent. Only successful compactions are shown. Missing measurements are shown as —.</p>
<p id="memory-error" class="error" role="status" hidden></p>
<div id="memory-results"></div><div class="dash-pager"><span id="memory-page"></span><div class="row"><button id="memory-prev">← Previous</button><button id="memory-next">Next →</button></div></div>
<div id="memory-back" class="dash-drawer-back"><section id="memory-drawer" class="dash-drawer" role="dialog" aria-modal="true" aria-label="Memory activity details" tabindex="-1"></section></div>
`;
export const memoryActivityClient = String.raw`
(function(){
 const byId=id=>document.getElementById(id),txt=escHtml;
 let page=0,generation=0,detailGeneration=0,busy=false,controller=null,selected=null,focus=null,detailBusy=false,applying=false;
 const field=id=>byId('memory-'+id).value;
 const number=compactNumber;
 const time=n=>n==null?'—':new Date(n).toLocaleString('en-GB',{timeZone:dashboardTimezone});
 const age=n=>{if(n==null)return '—';const seconds=Math.max(0,Math.floor((Date.now()-n)/1000));return seconds<60?seconds+'s ago':seconds<3600?Math.floor(seconds/60)+'m ago':seconds<86400?Math.floor(seconds/3600)+'h '+Math.floor(seconds%3600/60)+'m ago':Math.floor(seconds/86400)+'d ago';};
 const timeCell=n=>txt(time(n))+'<br><span class="live-note">'+txt(age(n))+'</span>';
 const percent=(value,total)=>value==null||!(total>0)?'—':(value/total*100).toFixed(2)+'%';
 const tokens=(value,window)=>number(value)+(value!=null&&window>0?'<br><span class="live-note">'+percent(value,window)+' of window</span>':'');
 const reduction=(before,after)=>before==null||after==null?'—':number(before-after)+'<br><span class="live-note">'+percent(before-after,before)+' reduction</span>';
 const title=kind=>kind==='memory_dream'?'Memory dream':'Session compaction';
 const badge=taskStatusBadge;
 const reason=value=>{const labels={pending_input:'Pending input',active_tasks:'Active tasks',recent_activity:'Recently active',unchanged_measurement:'No new measurement',no_measurement:'No recorded measurement',already_compacted:'Already compacted',context_changed:'Context changed; awaiting a fresh measurement',below_threshold:'Below context threshold',run_limit:'Run limit reached',model_window_unavailable:'Context window unavailable',missing_transcript:'Session transcript unavailable',agent_busy:'Agent is responding',gateway_stopping:'Gateway is stopping',COMPACTION_FAILED:'Compaction failed',INTERRUPTED:'Interrupted'};return labels[value]||String(value||'—').replace(/_/g,' ').toLowerCase().replace(/^./,c=>c.toUpperCase());};
 const showError=message=>{byId('memory-error').textContent=message;byId('memory-error').hidden=!message;};
 const table=(head,rows)=>{const widths=head[0]==='Agent'?[20,22,23,17,18]:head[0]==='Time / Agent'?[25,10,17,17,21,10]:head.length===6?[17,15,15,14,29,10]:[24,18,19,17,22];return '<div class="table-wrap"><table class="data-table memory-table" style="min-width:'+(head.length===6?900:660)+'px"><colgroup>'+widths.map(w=>'<col style="width:'+w+'%">').join('')+'</colgroup><thead><tr>'+head.map(h=>'<th>'+h+'</th>').join('')+'</tr></thead><tbody>'+rows.join('')+'</tbody></table></div>';};
 const query=()=>new URLSearchParams({agentId:field('agent'),kind:field('kind'),status:field('status'),scope:dashboardScope,page:String(page),completedOnly:'true'});
 function close(){detailGeneration++;selected=null;byId('memory-back').classList.remove('open');document.body.style.overflow='';if(focus?.isConnected)focus.focus();}
 async function load(force){
   if(document.hidden||byId('view-dreams').style.display==='none')return;
   if(force){controller?.abort();busy=false;page=0;}
   if(busy)return;
   busy=true;const version=++generation;controller=new AbortController();
   byId('memory-updated').textContent='Updating…';
   try{
     const response=await fetch(apiUrl('/dashboard/memory-activity')+'?'+query(),{signal:controller.signal});
     if(response.status===401){onUnauthorized();return;}if(!response.ok)throw Error('HTTP '+response.status);
     const data=await response.json();if(version!==generation)return;
     byId('memory-range-note').textContent=dashboardScope==='all'?'All recorded history.':'Since '+new Date(data.since).toLocaleString('en-GB',{timeZone:data.timezone})+' ('+data.timezone+').';
     const previous=field('agent');byId('memory-agent').innerHTML='<option value="">All agents</option>'+data.agents.map(a=>'<option value="'+txt(a)+'">'+txt(a)+'</option>').join('');byId('memory-agent').value=previous;
     const compactView=field('kind')==='session_compaction';
     byId('memory-stats').innerHTML=(compactView?[['Compacted sessions',data.counts.compactedSessions],['Tokens reduced · measured',data.counts.measuredSessions?data.counts.measuredReduction:null],['Measured sessions',data.counts.measuredSessions]]:[['Recorded runs',data.counts.runs],['Proposals to review',data.counts.pendingProposals],['Failed runs',data.counts.failed]]).map(([label,n])=>'<div class="dash-stat"><span>'+label+'</span><strong>'+number(n)+'</strong></div>').join('');
     showError((data.unavailable||[]).join(' · '));
     byId('memory-results').innerHTML=data.runs.length?table(compactView?['Time / Agent','Sessions','Before','After','Reduced','Details']:['Time','Agent','Activity','Status','Summary','Details'],data.runs.map(r=>'<tr data-memory-id="'+txt(r.id)+'" data-memory-agent="'+txt(r.agent)+'">'+(compactView?'<td>'+timeCell(r.startedAt)+'<br>'+agentBadge(r.agent)+'</td><td>'+number(r.completedSessions)+'</td><td>'+tokens(r.beforeTokens,r.contextWindow)+'</td><td>'+tokens(r.afterTokens,r.contextWindow)+'</td><td>'+reduction(r.beforeTokens,r.afterTokens)+'</td>':'<td>'+timeCell(r.startedAt)+'</td><td>'+agentBadge(r.agent)+'</td><td>'+title(r.kind)+'</td><td>'+badge(r.status)+'</td><td>'+(r.kind==='memory_dream'?txt(r.summary||r.outcome):'<strong>'+number(r.beforeTokens)+' → '+number(r.afterTokens)+'</strong><br>'+percent(r.beforeTokens,r.contextWindow)+' → '+percent(r.afterTokens,r.contextWindow)+' of window<br>'+reduction(r.beforeTokens,r.afterTokens))+'</td>')+'<td><button data-memory-open>Inspect</button></td></tr>')):'<p class="empty">No recorded activities match these filters.</p>';
     byId('memory-page').textContent='Page '+(page+1)+' · '+number(data.total)+' runs';byId('memory-prev').disabled=page===0;byId('memory-next').disabled=(page+1)*25>=data.total;
     byId('memory-updated').textContent='Updated '+new Date().toLocaleTimeString('en-GB',{timeZone:dashboardTimezone});
     if(selected?.status==='running'&&!detailBusy&&!applying)void detail(selected.agent,selected.id,true);
   }catch(error){if(error.name!=='AbortError'&&version===generation){showError('Unable to load activity: '+error.message);byId('memory-updated').textContent='Retrying…';}}
   finally{if(version===generation)busy=false;}
 }
 async function detail(agent,id,refresh=false){
   const version=++detailGeneration;detailBusy=true;
   if(!refresh){dashClose();focus=document.activeElement;selected={agent,id};}
   const panel=byId('memory-drawer');
   if(!refresh){byId('memory-back').classList.add('open');document.body.style.overflow='hidden';panel.focus();panel.innerHTML='<button data-memory-close>Close ×</button><p>Loading recorded details…</p>';}
   try{
    const response=await fetch(apiUrl('/dashboard/memory-activity')+'?'+new URLSearchParams({agentId:agent,id,completedOnly:'true'}));
    if(response.status===401){onUnauthorized();return;}if(!response.ok)throw Error('HTTP '+response.status);
    const {run:r}=await response.json();if(version!==detailGeneration)return;
    let body='<button data-memory-close>Close ×</button><h1>'+title(r.kind)+'</h1><p class="live-note">'+agentBadge(agent)+' · '+txt(time(r.startedAt))+'</p>'+badge(r.status)+'<p id="memory-apply-result" role="status"></p>';
    if(r.kind==='memory_dream'){
      body+='<h2>Summary</h2><p>'+txt(r.summary||'No summary recorded')+'</p><p class="live-note">Mode: '+txt(r.mode)+' · Outcome: '+txt(r.outcome)+' · Tokens: '+number(r.tokens)+' · Sessions: '+number(r.sessions)+'</p>';
      if(r.pendingProposals)body+='<button data-memory-accept="all" data-memory-ts="'+Number(r.ts)+'">Accept all pending ('+number(r.pendingProposals)+')</button>';
      body+='<h2>Memory proposals</h2>'+(r.proposals||[]).map(p=>'<section class="dash-panel"><h3>'+txt(p.op)+' · '+txt(p.file)+'</h3><p>'+txt(p.reason)+'</p>'+(p.target?'<h4>Current text</h4><pre>'+txt(p.target)+'</pre>':'')+(p.content?'<h4>Proposed text</h4><pre>'+txt(p.content)+'</pre>':'')+'<p class="live-note">Score: '+number(p.score)+' · Recall: '+number(p.recallCount)+'</p>'+(p.accepted?badge('accepted'):r.mode==='propose'?'<button data-memory-accept="'+Number(p.index)+'" data-memory-ts="'+Number(r.ts)+'">Accept proposal</button>':'')+'</section>').join('');
    }else{
      body+='<h2>Run settings</h2><p>Context threshold '+number(r.config.thresholdPercent)+'% · Quiet '+number(r.config.quietMinutes)+' minutes · Maximum '+number(r.config.maxSessionsPerRun)+' sessions</p><p class="live-note">Ended: '+txt(time(r.endedAt))+'. Native context compaction preserves canonical chat history. Token values describe context, not cost. Before/after percentages use the context window; reduction uses the before value. Measurements use saved CLI metadata only—no additional model requests.</p><h2>Sessions</h2><p class="live-note">Showing '+number((r.items||[]).length)+' of '+number(r.itemCount??(r.items||[]).length)+' recorded sessions.</p>';
      body+=table(['Session','Before','After','Reduced','Duration'],(r.items||[]).map(item=>'<tr><td style="white-space:normal;overflow-wrap:anywhere">'+txt(item.sessionId)+'</td><td>'+tokens(item.beforeTokens,item.contextWindow)+'</td><td>'+tokens(item.afterTokens,item.contextWindow)+'</td><td>'+reduction(item.beforeTokens,item.afterTokens)+'</td><td>'+txt(item.endedAt!=null?Math.round((item.endedAt-item.startedAt)/1000)+'s':'—')+'</td></tr>'));
    }
    const signature=JSON.stringify(r);selected.status=r.status;
    if(!refresh||panel.dataset.record!==signature){
      const scroll=panel.scrollTop,active=document.activeElement,inside=panel.contains(active),accept=active?.dataset?.memoryAccept;
      const previousNotice=byId('memory-apply-result')?.textContent||'';const notice=previousNotice==='Detail refresh unavailable; retrying.'?'':previousNotice;
      panel.innerHTML=body;panel.dataset.record=signature;panel.scrollTop=scroll;
      byId('memory-apply-result').textContent=notice;
      if(inside){const replacement=accept!==undefined?[...panel.querySelectorAll('[data-memory-accept]')].find(b=>b.dataset.memoryAccept===accept):active?.hasAttribute('data-memory-close')?panel.querySelector('[data-memory-close]'):panel; (replacement||panel).focus({preventScroll:true});}
    }
   }catch(error){if(version===detailGeneration){if(refresh&&byId('memory-apply-result'))byId('memory-apply-result').textContent='Detail refresh unavailable; retrying.';else panel.innerHTML='<button data-memory-close>Close ×</button><p class="error">Unable to read details: '+txt(error.message)+'</p>';}}finally{if(version===detailGeneration)detailBusy=false;}
 }
 byId('memory-results').addEventListener('click',e=>{const row=e.target.closest('[data-memory-id]');if(row)detail(row.dataset.memoryAgent,row.dataset.memoryId);});
 byId('memory-back').addEventListener('click',async e=>{
   if(e.target.id==='memory-back'||e.target.closest('[data-memory-close]')){close();return;}
   const button=e.target.closest('[data-memory-accept]');if(!button||!selected||applying)return;applying=true;
   const target={...selected};const version=detailGeneration;
   byId('memory-drawer').querySelectorAll('[data-memory-accept]').forEach(b=>b.disabled=true);
   try{
     const payload={agentId:target.agent,ts:Number(button.dataset.memoryTs)};if(button.dataset.memoryAccept!=='all')payload.indexes=[Number(button.dataset.memoryAccept)];
     const response=await fetch(apiUrl('/knowledge/dreams/apply'),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
     if(response.status===401){onUnauthorized();return;}const result=await response.json();if(!response.ok)throw Error(result.error||'Apply failed');
     if(version!==detailGeneration)return;await detail(target.agent,target.id,true);
     if(selected?.id===target.id&&selected?.agent===target.agent)byId('memory-apply-result')&&(byId('memory-apply-result').textContent='Applied '+number(result.applied)+' · Skipped '+number(result.skipped)+' · Already accepted '+number(result.alreadyAccepted));
     load(false);
   }catch(error){if(version===detailGeneration){byId('memory-apply-result').textContent=error.message;byId('memory-drawer').querySelectorAll('[data-memory-accept]').forEach(b=>b.disabled=false);}}finally{applying=false;if(selected?.id===target.id&&selected?.agent===target.agent)byId('memory-drawer').querySelectorAll('[data-memory-accept]').forEach(b=>b.disabled=false);}
 });
 document.addEventListener('keydown',e=>{if(!selected)return;if(e.key==='Escape')close();if(e.key==='Tab'){const nodes=[...byId('memory-drawer').querySelectorAll('button,a,summary')].filter(n=>n.getClientRects().length),first=nodes[0],last=nodes[nodes.length-1];if(e.shiftKey&&(document.activeElement===first||document.activeElement===byId('memory-drawer'))){e.preventDefault();last?.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first?.focus();}}});
 ['agent','kind','status'].forEach(id=>byId('memory-'+id).addEventListener('change',()=>{close();load(true);}));
 byId('memory-refresh').onclick=()=>load(true);byId('memory-prev').onclick=()=>{page=Math.max(0,page-1);controller?.abort();busy=false;load(false);};byId('memory-next').onclick=()=>{page++;controller?.abort();busy=false;load(false);};
 document.addEventListener('click',e=>{if(e.target.closest('.tab')&&selected)close();});
 document.addEventListener('visibilitychange',()=>{if(!document.hidden)load(false);});
 setInterval(()=>load(false),15000);window.__loadDreams=force=>load(Boolean(force));
})();
`;
