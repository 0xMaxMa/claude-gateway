/** Shared controls for dashboard pages and standalone reports. */
export function themeButtonHtml(id: 'dash-theme' | 'report-theme'): string {
  return `<button type="button" class="theme-toggle" id="${id}" data-theme-toggle aria-label="Switch to dark theme" title="Switch to dark theme"><svg class="theme-moon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M20.5 13A8.5 8.5 0 0 1 11 3.5 8.5 8.5 0 1 0 20.5 13Z"/></svg><svg class="theme-sun" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"/></svg></button>`;
}
export const dashboardControlsClient = String.raw`
function dashboardCloseButton(action){
 return '<div class="drawer-actions"><button type="button" class="drawer-close" data-'+action+'-close aria-label="Close details">Close ×</button></div>';
}
(function(){
 const key='gateway-dashboard-theme';
 function apply(theme){
  document.documentElement.dataset.theme=theme;
  document.querySelectorAll('[data-theme-toggle]').forEach(button=>{const label=theme==='dark'?'Switch to light theme':'Switch to dark theme';button.setAttribute('aria-label',label);button.title=label;});
 }
 try{const saved=localStorage.getItem(key);apply(saved==='dark'?'dark':'light');}catch{apply(document.documentElement.dataset.theme||'light');}
 document.addEventListener('click',event=>{
  if(!event.target.closest('[data-theme-toggle]'))return;
  const theme=document.documentElement.dataset.theme==='dark'?'light':'dark';apply(theme);try{localStorage.setItem(key,theme);}catch{}
 });
 window.addEventListener('storage',event=>{if(event.key===key)apply(event.newValue==='dark'?'dark':'light');});
})();
`;
