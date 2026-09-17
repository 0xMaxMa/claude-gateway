/** Refresh rendered data only; keep filters, theme, scroll and the open turn-detail panel. */
export const tokenReportClient = `
var reportRefreshing=false;
async function refreshReport(){
 if(document.hidden||reportRefreshing)return;
 reportRefreshing=true;
 var status=document.getElementById('report-live');
 try{
  var response=await fetch(location.href,{cache:'no-store',headers:{Accept:'text/html'}});
  if(response.status===401){location.reload();return;}
  if(!response.ok)throw Error('Unavailable');
  var next=new DOMParser().parseFromString(await response.text(),'text/html');
  if(next.getElementById('login-form')){location.reload();return;}
  if(!next.getElementById('report-totals'))throw Error('Unavailable');
  var scrolls=Array.from(document.querySelectorAll('.table-scroll')).map(function(el){return el.scrollLeft;});
  var x=scrollX,y=scrollY;
  ['report-totals','report-footprint','report-distribution'].forEach(function(id){var old=document.getElementById(id),fresh=next.getElementById(id);if(old.innerHTML!==fresh.innerHTML)old.innerHTML=fresh.innerHTML;});
  var body=document.querySelector('.report-table tbody'),freshBody=next.querySelector('.report-table tbody');
  if(body.innerHTML!==freshBody.innerHTML)body.innerHTML=freshBody.innerHTML;
  var pagers=next.querySelectorAll('.report-pager');document.querySelectorAll('.report-pager').forEach(function(el,i){if(pagers[i])el.innerHTML=pagers[i].innerHTML;});
  filter();if(typeof reportRenderDrawer==='function')reportRenderDrawer();document.querySelectorAll('.table-scroll').forEach(function(el,i){el.scrollLeft=scrolls[i]||0;});scrollTo(x,y);
  status.textContent='Live · updated '+new Date().toLocaleTimeString();
 }catch(e){status.textContent='Reconnecting… · data may be outdated';}
 finally{reportRefreshing=false;}
}
setInterval(refreshReport,5000);
document.addEventListener('visibilitychange',function(){if(!document.hidden)refreshReport();});
`;
