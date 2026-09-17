/** Shared tokens from the approved pastel dashboard direction. */
export const dashboardTheme = String.raw`
:root{color-scheme:dark;--bg:#101113;--side:#141517;--panel:#181a1d;--raised:#202226;--line:#2b2e33;--text:#eeeef0;--muted:#989da7;--accent:#ff935c;--accentbg:#35261f;--green:#78d5aa;--greenbg:#1e3029;--blue:#8dbdff;--bluebg:#202c3f;--yellow:#ebc978;--yellowbg:#342e20;--red:#efa19e;--redbg:#362426;--shadow:0 24px 100px #0008;--radius:14px}

[data-theme=light]{color-scheme:light;--bg:#f5f5f4;--side:#fafaf9;--panel:#fff;--raised:#f0f1f2;--line:#e2e3e5;--text:#202226;--muted:#686d76;--accent:#b94815;--accentbg:#fff0e6;--green:#217451;--greenbg:#eaf7ef;--blue:#3264a7;--bluebg:#edf3fe;--yellow:#87621b;--yellowbg:#fff5de;--red:#a84140;--redbg:#fff0f0;--shadow:0 24px 100px #28282a22}

*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:14px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;-webkit-font-smoothing:antialiased}
button,input,select{font:inherit}
button,a,input,select{ -webkit-tap-highlight-color:transparent}
button{cursor:pointer;color:inherit}
button:focus-visible,a:focus-visible,input:focus-visible,select:focus-visible{outline:2px solid var(--accent);outline-offset:3px}
button{border:1px solid var(--line);border-radius:8px;background:var(--panel);padding:8px 12px;display:inline-flex;gap:8px;align-items:center;justify-content:center}
button:hover{background:var(--raised)}
button:disabled{opacity:.4;cursor:not-allowed}
.primary{background:var(--accent);border-color:var(--accent);color:#1b130e;font-weight:650}
[data-theme=light] .primary{color:white}
.primary:hover{filter:brightness(1.08);background:var(--accent)}
.quiet{background:transparent;border-color:transparent}
.danger{color:var(--red)}
svg.icon{width:18px;height:18px;flex-shrink:0;fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round}
.small{font-size:12px}
.muted{color:var(--muted)}
.mono{font:12px/1.5 ui-monospace,SFMono-Regular,Consolas,monospace}
.row{display:flex;align-items:center;gap:10px}
.between{justify-content:space-between}
.wrap{flex-wrap:wrap}
.gap{gap:16px}
h1,h2,h3,p{margin:0}
h1{font-size:30px;letter-spacing:-1px;font-weight:650;line-height:1.2}
h2{font-size:16px;letter-spacing:-.2px;font-weight:620}
h3{font-size:14px;font-weight:600}
a{color:var(--accent);text-decoration:none}
.layout{display:grid;grid-template-columns:224px minmax(0,1fr);min-height:100vh}
.sidebar{background:var(--side);border-right:1px solid var(--line);padding:28px 16px 16px;display:flex;flex-direction:column;position:fixed;inset:0 auto 0 0;width:224px;z-index:20}
.brand{padding:0 10px 26px;gap:11px;line-height:1.2;letter-spacing:-.4px;font-size:16px;font-weight:680}
.brandmark{width:34px;height:34px;border-radius:10px;background:var(--accentbg);color:var(--accent);display:grid;place-items:center;border:1px solid color-mix(in srgb,var(--accent) 20%,transparent)}
.brand small{display:block;font-size:11px;color:var(--muted);font-weight:450;letter-spacing:.8px;margin-top:5px}
.navlabel{font-size:10px;color:var(--muted);letter-spacing:1.4px;font-weight:650;margin:24px 12px 10px}
.nav{display:flex;flex-direction:column;gap:5px}
.nav button{justify-content:flex-start;border-color:transparent;background:transparent;color:var(--muted);padding:11px 12px;font-weight:520}
.nav button:hover{background:var(--raised);color:var(--text)}
.nav button.active{background:var(--accentbg);color:var(--accent)}
.count{margin-left:auto;background:var(--raised);padding:0px 7px;border-radius:5px;font-size:11px;color:var(--muted)}
.sidebarfoot{margin-top:auto;padding-top:28px}
.instance{border:1px solid var(--line);padding:13px;border-radius:10px}
.dot{width:7px;height:7px;border-radius:50%;background:var(--green);display:inline-block;flex-shrink:0}
.main{grid-column:2;min-width:0}
.topbar{height:70px;padding:0 38px;display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid var(--line);gap:12px}
.breadcrumb{color:var(--muted);font-size:12px}
.breadcrumb span{margin-left:12px;color:var(--text)}
.pill{display:inline-flex;align-items:center;gap:6px;padding:4px 8px;border-radius:6px;font-size:11px;white-space:nowrap;font-weight:550;background:var(--raised);color:var(--muted)}
.pill.green{color:var(--green);background:var(--greenbg)}
.pill.orange{color:var(--accent);background:var(--accentbg)}
.pill.blue{color:var(--blue);background:var(--bluebg)}
.pill.yellow{color:var(--yellow);background:var(--yellowbg)}
.pill.red{color:var(--red);background:var(--redbg)}
.page{max-width:1460px;margin:auto;padding:36px 38px 48px}
.heading{margin-bottom:26px}
.heading p{color:var(--muted);margin-top:9px}
.eyebrow{text-transform:uppercase;letter-spacing:1.6px;color:var(--accent);font-size:10px;font-weight:650;margin-bottom:10px}
.stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:16px;margin-bottom:24px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);min-width:0;overflow:hidden}
.stat{padding:20px}
.stat-label{color:var(--muted);font-size:12px}
.statvalue{font-size:30px;font-weight:600;letter-spacing:-.8px;margin:12px 0 6px;line-height:1.2}
.statvalue small{font-size:13px;font-weight:450;letter-spacing:0;color:var(--muted)}
.stat-foot{font-size:11px;color:var(--muted)}
.spark{width:70px;height:26px;fill:none;stroke:var(--green);stroke-width:1.7}
.columns{display:grid;grid-template-columns:minmax(0,1.8fr) minmax(280px,1fr);gap:22px}
.cardhead{padding:20px 22px;display:flex;align-items:center;justify-content:space-between;gap:12px}
.cardhead p{color:var(--muted);font-size:12px;margin-top:4px}
.padded{padding:0 22px 22px}
.chart{position:relative}
.chart svg{display:block;width:100%;height:175px}
.legend{display:flex;gap:17px;font-size:11px;color:var(--muted)}
.legend i{display:inline-block;width:7px;height:7px;border-radius:3px;background:var(--accent);margin-right:5px}
.chartlabels{display:flex;justify-content:space-between;color:var(--muted);font-size:10px;margin-top:9px}
.notice{background:var(--yellowbg);border:1px solid color-mix(in srgb,var(--yellow) 20%,transparent);padding:15px;border-radius:10px}
.notice p{font-size:12px;margin:7px 0 12px;color:var(--muted)}
.separator{height:1px;background:var(--line);margin:20px 0}
.stack{display:grid;gap:12px}
.activity{display:flex;gap:12px;padding:13px 0;border-bottom:1px solid var(--line)}
.activity:last-child{border:0}
.avatar{height:32px;width:32px;border-radius:9px;background:var(--bluebg);color:var(--blue);display:grid;place-items:center;font-size:12px;font-weight:600;flex-shrink:0}
.avatar.orange{background:var(--accentbg);color:var(--accent)}
.activity p{font-size:12px;color:var(--muted);margin-top:4px}
.activity time{margin-left:auto;font-size:10px;color:var(--muted);white-space:nowrap}
.section{margin-top:24px}
.tablewrap{overflow:auto}
table{width:100%;border-collapse:collapse;text-align:left;white-space:nowrap}
th{font-size:10px;color:var(--muted);font-weight:550;letter-spacing:.6px;text-transform:uppercase;padding:11px 22px;border-bottom:1px solid var(--line);background:color-mix(in srgb,var(--raised) 35%,transparent)}
td{padding:15px 22px;border-bottom:1px solid var(--line);font-size:12px}
tbody tr:last-child td{border:0}
tbody tr[data-detail]{cursor:pointer}
tbody tr[data-detail]:hover{background:var(--raised)}
td strong{font-weight:550}
td small{display:block;color:var(--muted);font-size:11px;margin-top:4px}
.tablefoot{padding:13px 22px;border-top:1px solid var(--line);color:var(--muted);font-size:11px}
.bar{height:6px;background:var(--raised);border-radius:4px;overflow:hidden}
.bar span{display:block;height:100%;background:var(--accent);border-radius:4px}
.progressrow{margin-bottom:19px}
.progressrow .row{margin-bottom:8px;font-size:12px}
.tabs{display:flex;gap:4px;border-bottom:1px solid var(--line);margin-bottom:24px}
.tabs button{border:none;background:transparent;border-radius:0;color:var(--muted);padding:12px 14px;border-bottom:2px solid transparent}
.tabs button.selected{color:var(--accent);border-bottom-color:var(--accent)}
input,select{border:1px solid var(--line);border-radius:8px;background:var(--panel);color:var(--text);padding:9px 12px;min-width:0}
.search{max-width:320px;width:100%}
.filters{margin-bottom:18px}
.empty{text-align:center;color:var(--muted);padding:40px}
.token-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:16px}
.swatches{display:grid;grid-template-columns:repeat(4,1fr);gap:10px}
.swatch{height:58px;border:1px solid var(--line);border-radius:9px;margin-bottom:8px}
.swatches p{font-size:11px}
.swatches code{font-size:10px;color:var(--muted)}
.spec{padding:22px}
.spec h2{margin-bottom:8px}
.spec>p{color:var(--muted);font-size:12px;margin-bottom:20px}
.type-line{border-bottom:1px solid var(--line);padding:12px 0;display:flex;justify-content:space-between;gap:20px;align-items:center}
.type-line:last-child{border:0}
.type-line code{color:var(--muted);font-size:11px}
.designgrid{display:grid;grid-template-columns:1fr 1fr;gap:20px}
.timeline{border-left:1px solid var(--line);margin-left:7px;padding-left:22px}
.step{padding-bottom:26px;position:relative}
.step:before{content:'';position:absolute;left:-27px;top:6px;width:8px;height:8px;border-radius:100%;background:var(--blue);border:2px solid var(--panel)}
.step p{color:var(--muted);font-size:12px;margin-top:6px}
.code{font:12px/1.6 ui-monospace,SFMono-Regular,monospace;background:var(--bg);border:1px solid var(--line);padding:12px;border-radius:8px;white-space:pre-wrap;margin-top:12px}
.drawerback{position:fixed;inset:0;background:#0006;z-index:50;display:none}
.drawerback.open{display:block}
.drawer{position:absolute;right:0;top:0;bottom:0;width:min(540px,100%);background:var(--panel);border-left:1px solid var(--line);box-shadow:var(--shadow);padding:26px;overflow:auto}
.drawer h1{font-size:24px;margin:24px 0 10px}
.drawer .pill{margin-bottom:24px}
.drawer dl{display:grid;grid-template-columns:100px 1fr;font-size:12px;gap:10px;margin:20px 0}
.drawer dt{color:var(--muted)}
.drawer dd{margin:0}
.toast{position:fixed;bottom:24px;left:50%;transform:translateX(-50%);padding:12px 18px;background:var(--raised);border:1px solid var(--line);border-radius:10px;box-shadow:var(--shadow);z-index:100;display:none}
.preview{font-size:10px;color:var(--muted);border:1px solid var(--line);border-radius:5px;padding:4px 8px;letter-spacing:.3px}
.mobilemenu{display:none}
.footer{display:flex;justify-content:space-between;margin-top:28px;color:var(--muted);font-size:10px}
.metric-note{border-left:2px solid var(--accent);padding-left:12px;font-size:12px;color:var(--muted);margin-top:20px}
.ds-spaces{display:flex;align-items:end;gap:20px;min-height:70px}
.ds-spaces span{display:block;background:var(--accentbg);border-top:2px solid var(--accent);width:28px}
.ds-spaces small{display:block;margin-top:8px;color:var(--muted);font-size:10px}
button.link{padding:0;border:0;background:none;color:var(--accent);font-size:12px}
.statuslist>.row{padding:14px 0;border-bottom:1px solid var(--line)}
.statuslist>.row:last-child{border:0}
.keycap{border:1px solid var(--line);padding:1px 5px;border-radius:4px;font-size:10px}
.memoryrow{padding:20px;border:1px solid var(--line);border-radius:10px;margin-bottom:12px}
.memoryrow p{color:var(--muted);font-size:12px;margin-top:5px}

@media(min-width:1600px){.page{padding-top:44px}
}
@media(max-width:1100px){.columns{grid-template-columns:1fr}
.stats{grid-template-columns:repeat(2,1fr)}
.page{padding:28px 24px}
.topbar{padding:0 24px}
.designgrid{grid-template-columns:1fr}
}
@media(max-width:760px){.layout{grid-template-columns:1fr}
.main{grid-column:1}
.sidebar{transform:translateX(-100%);box-shadow:var(--shadow)}
body.menuopen .sidebar{transform:translateX(0)}
.mobilemenu{display:inline-flex}
.topbar{padding:0 16px;height:62px}
.breadcrumb{display:none}
.page{padding:24px 16px}
.heading{align-items:flex-start}
.heading h1{font-size:26px}
.heading>.row{flex-wrap:wrap}
.stats{gap:10px}
.stat{padding:16px}
.statvalue{font-size:26px}
.token-grid{grid-template-columns:1fr}
.swatches{grid-template-columns:repeat(2,1fr)}
.preview{max-width:150px;text-align:center}
.footer{gap:12px}
.filters{flex-wrap:wrap}
.cardhead{padding:18px}
.topbar .pill{display:none}
}
@media(prefers-reduced-motion:no-preference){button,.sidebar{transition:background .15s,transform .2s}
.page{animation:reveal .22s ease}
@keyframes reveal{from{opacity:.5;transform:translateY(4px)}
to{opacity:1;transform:none}
}
}


/* V3: a white workspace with violet controls and pastel category surfaces. */
:root,[data-theme=light]{color-scheme:light;--bg:#f5f6f8;--side:#fff;--panel:#fff;--raised:#f5f6f8;--line:#dddfeb;--text:#333;--muted:#535768;--accent:#6161ff;--accentbg:#e7ecff;--green:#226149;--greenbg:#e5f6dc;--blue:#355a80;--bluebg:#dff4fc;--yellow:#785622;--yellowbg:#fff0d8;--red:#9c405d;--redbg:#fce8ef;--shadow:0 12px 42px #35386612;--radius:24px;--mint:#e2f8d3;--sky:#dff6ff;--peach:#fff0e3;--lavender:#eddff7;--prism:conic-gradient(#8181ff,#4dc2cb,#a5db88,#f8e094,#f3a0d2,#8181ff)}

[data-theme=dark]{color-scheme:dark;--bg:#171824;--side:#1d1f2e;--panel:#222536;--raised:#2a2e42;--line:#393e57;--text:#f1f1f8;--muted:#b2b7cc;--accent:#a5a5ff;--accentbg:#353858;--green:#abd8b3;--greenbg:#293e33;--blue:#adcce9;--bluebg:#2b3b51;--yellow:#e4c792;--yellowbg:#443b2a;--red:#f1afc3;--redbg:#473044;--shadow:0 12px 42px #0002;--mint:#263b30;--sky:#253a4b;--peach:#423328;--lavender:#3a2f4b}

body{font-family:Poppins,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:13px;letter-spacing:-.01em}
h1{font-size:44px;line-height:1.2;letter-spacing:-.035em;font-weight:400}
h2{font-size:17px;font-weight:500;letter-spacing:-.02em}
h3{font-weight:500}
.mono{font-variant-numeric:tabular-nums}
.layout{grid-template-columns:242px minmax(0,1fr)}
.sidebar{width:242px;padding:30px 18px 18px}
.brand{font-size:15px;font-weight:600;padding:0 8px 24px;gap:10px}
.brandmark{border:0;border-radius:12px;background:var(--prism);color:#333;width:35px;height:35px}
.brand small{font-size:9px;letter-spacing:1.1px;margin-top:6px}
.navlabel{font-weight:500;letter-spacing:1.5px;font-size:9px;margin-top:28px}
.nav{gap:6px}
.nav button{font-size:12px;font-weight:500;padding:12px 13px;border-radius:8px}
.nav button.active{background:var(--accentbg);color:var(--accent)}
.count{font-size:10px;border-radius:6px;background:var(--raised)}
.instance{border-radius:16px;background:var(--raised);border:0;padding:16px}
.avatar{border-radius:10px}
.topbar{height:80px;background:var(--panel);border:0;padding:0 36px}
.preview{border-radius:6px;padding:5px 9px;font-size:9px}
.breadcrumb{font-size:11px}
.page{max-width:1440px;padding:34px 36px 44px}
.heading{margin-bottom:28px;gap:20px}
.heading p{font-size:13px;line-height:1.7;max-width:690px;margin-top:13px}
.eyebrow{font-size:9px;letter-spacing:1.6px;color:var(--muted);font-weight:500;margin-bottom:12px}
.gradient-title{background:linear-gradient(95deg,#398ca8,#6161ff 58%,#8950ca);background-clip:text;-webkit-background-clip:text;color:transparent}
.heading>button{flex-shrink:0}

button{border-radius:160px;padding:10px 17px;font-size:12px;font-weight:500;min-height:38px}
.primary,[data-theme=light] .primary{color:#fff;background:#6161ff;border-color:#6161ff}
.primary:hover{background:#5050e7;filter:none}
.quiet{border-color:transparent}
.danger{color:var(--red)}
button.link{font-size:11px;min-height:32px}
.pill{border-radius:6px;font-size:10px;padding:5px 9px;font-weight:500}
.pill.orange{background:var(--accentbg);color:var(--accent)}
.pill.green{background:var(--greenbg)}

.stats{gap:16px;margin-bottom:28px}
.stats .stat{border:0;padding:24px;border-radius:24px}
.stats .stat:nth-child(1){background:var(--mint)}
.stats .stat:nth-child(2){background:var(--sky)}
.stats .stat:nth-child(3){background:var(--lavender)}
.stats .stat:nth-child(4){background:var(--peach)}
.stat-label{font-size:11px;color:var(--text)}
.stat .icon{width:17px;height:17px;color:var(--text);opacity:.65}
.statvalue{font-size:36px;font-weight:400;letter-spacing:-.03em;margin:13px 0 9px}
.statvalue small{font-size:12px}
.stat-foot{font-size:10px;line-height:1.7}
.spark{width:48px;stroke:var(--text);opacity:.5}
.columns{gap:24px;grid-template-columns:minmax(0,1.65fr) minmax(300px,1fr)}
.card{box-shadow:0 3px 14px #35386604}
.cardhead{padding:24px}
.cardhead p{font-size:11px;line-height:1.7}
.padded{padding:0 24px 24px}
.notice{background:var(--peach);border:0;border-radius:16px;padding:20px}
.notice p{font-size:12px;line-height:1.8;margin:10px 0 16px}
.notice button{background:#6161ff;color:white;border-color:#6161ff}
.separator{margin:22px 0}
.metric-note{font-size:11px;border-left:2px solid var(--accentbg);line-height:1.7}
.chart svg{height:180px}
.legend{font-size:10px}
.chartlabels{font-size:9px}
.section{margin-top:26px}
th{font-size:9px;padding:13px 24px;background:var(--raised);letter-spacing:.6px}
td{padding:18px 24px;font-size:11px}
td strong{font-weight:500}
td small{font-size:10px}
.tablefoot{padding:14px 24px;font-size:10px}
tbody tr[data-detail]:hover{background:var(--accentbg)}
.tabs{gap:6px;border:0;flex-wrap:wrap}
.tabs button{border:1px solid var(--line);border-radius:160px;padding:9px 16px}
.tabs button.selected{color:white;background:#6161ff;border-color:#6161ff}
input,select{border-radius:6px;padding:10px 13px;font-size:12px}
.spec{padding:26px}
.spec>p{font-size:12px;line-height:1.75}
.swatch{border-radius:12px;height:68px}
.type-line{flex-wrap:wrap}
.type-line code{white-space:nowrap}
.ds-spaces{flex-wrap:wrap}
.drawer{padding:30px}
.drawer h1{font-size:28px;font-weight:400;line-height:1.35}
.drawer dd{overflow-wrap:anywhere}
.drawer .pill{margin-bottom:16px}
.drawer .code{background:var(--raised);border-radius:12px;border:0;padding:16px}
.footer{font-size:10px;line-height:1.6}
.page{animation:none}
.design-link{text-decoration:underline;text-underline-offset:4px;font-size:12px}
.board-sample{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin:16px 0}
.note{border-radius:16px;min-height:110px;padding:16px;background:var(--mint);font-size:12px;color:var(--text)}
.note:nth-child(2){background:var(--sky)}
.note:nth-child(3){background:var(--lavender)}
.note .icon{margin-bottom:12px;display:block}
.memoryrow{border-radius:16px}
.toast{border-radius:160px}

@media(max-width:1150px){.columns{grid-template-columns:1fr}
.page{padding:28px}
.topbar{padding:0 28px}
.stats{grid-template-columns:repeat(2,minmax(0,1fr))}
.designgrid{grid-template-columns:1fr}
.heading h1{font-size:38px}
}
@media(max-width:760px){.layout{grid-template-columns:1fr}
.main{grid-column:1}
.page{padding:24px 16px}
.topbar{padding:0 16px;height:64px}
.heading h1{font-size:34px}
.stats{gap:12px}
.stats .stat{padding:18px;border-radius:20px}
.statvalue{font-size:28px}
.stat-label{font-size:10px}
.spark{display:none}
.cardhead{padding:20px;flex-wrap:wrap}
.padded{padding:0 20px 22px}
.spec{padding:22px}
.columns{grid-template-columns:minmax(0,1fr)}
.designgrid{grid-template-columns:minmax(0,1fr)}
.preview{max-width:175px}
.drawer{padding:22px}
.token-grid{grid-template-columns:1fr}
.footer,.tablefoot{flex-wrap:wrap;gap:12px}
.board-sample{grid-template-columns:1fr}
.heading>button{align-self:flex-start}
}



body{padding:0}
.rainbow{background:none;-webkit-text-fill-color:var(--text);animation:none}
.shell-content{padding:32px 36px;max-width:1600px;margin:auto}
.sidebar .tabs{display:flex;flex-direction:column;border:0;margin:0;gap:6px}
.sidebar .tab{justify-content:flex-start;border:0;border-radius:8px;background:none;color:var(--muted);padding:12px 14px;font-size:12px}
.sidebar .tab.active{background:var(--accentbg);color:var(--accent)}
.sidebar .tab:focus-visible{outline:2px solid var(--accent)}
.topbar h1{font-size:16px;letter-spacing:0}
.meta{margin:0;font-size:11px;color:var(--muted)}
.meta span{color:var(--text)}
#top-right{float:none;display:flex;align-items:center;gap:12px}
#logout-btn{background:var(--panel);border:1px solid var(--line);color:var(--text);border-radius:160px;padding:8px 16px}
#refresh-indicator{color:var(--muted);font-size:10px}
.table-wrap{overflow:auto;border:1px solid var(--line);border-radius:24px;background:var(--panel)}
table{margin:0;white-space:normal}
th{background:var(--raised);color:var(--muted);border-color:var(--line)}
td,tr.session-row td{background:transparent;color:var(--text);border-color:var(--line)}
tr.session-row:hover td{background:var(--raised)}
.ts{color:var(--muted);overflow-wrap:anywhere}
.session-id{font-size:11px;overflow-wrap:anywhere;font-family:ui-monospace,monospace}
.badge{border-radius:6px;font-size:10px;font-weight:500}
.badge-green,.badge-haiku{background:var(--greenbg);color:var(--green)}
.badge-red{background:var(--redbg);color:var(--red)}
.badge-gray,.badge-model{background:var(--raised);color:var(--muted)}
.badge-blue,.badge-sonnet{background:var(--bluebg);color:var(--blue)}
.badge-purple,.badge-opus,.badge-fable{background:var(--accentbg);color:var(--accent)}
.btn-stream{border:1px solid var(--line);border-radius:160px;padding:7px 12px;color:var(--accent);background:var(--panel);font-size:11px;display:inline-flex;align-items:center;gap:6px}
.agent-badge{background:var(--panel);border:1px solid var(--line);color:var(--text);border-radius:12px}
.agent-name{color:var(--text)}
.proc-tree{background:var(--panel);border:1px solid var(--line);border-radius:24px;color:var(--text);padding:20px;overflow:auto}
.proc-row{color:var(--text)}
.kb-toolbar,.dreams-toolbar{background:var(--panel);color:var(--text);border-color:var(--line);padding:16px;border-radius:16px}
.kb-toolbar input,.kb-toolbar select,.dreams-toolbar select{background:var(--panel);color:var(--text);border-color:var(--line)}
.kb-container{background:var(--panel);border-color:var(--line)}
.kb-note,.dream-card{background:var(--panel);color:var(--text);border-color:var(--line)}
.empty{padding:32px;text-align:center;color:var(--muted)}
.dash-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:16px;margin:24px 0}
.dash-stat{padding:24px;border-radius:24px;background:var(--mint)}
.dash-stat:nth-child(2){background:var(--sky)}
.dash-stat:nth-child(3){background:var(--lavender)}
.dash-stat:nth-child(4){background:var(--peach)}
.dash-stat strong{display:block;font-size:32px;font-weight:400;margin-top:12px}
.dash-stat span{font-size:11px}
.dash-panel{background:var(--panel);border:1px solid var(--line);border-radius:24px;padding:24px;margin:24px 0}
.dash-panel h2{margin:0 0 16px;color:var(--text)}
.view>h2{margin:0 0 18px;color:var(--text)}
.dash-pager{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:18px 0;color:var(--muted);font-size:11px}
.dash-drawer-back{display:none;position:fixed;inset:0;z-index:100;background:#22253655}
.dash-drawer-back.open{display:block}
.dash-drawer{background:var(--panel);position:absolute;inset:0 0 0 auto;width:min(800px,100%);padding:28px;overflow:auto;box-shadow:var(--shadow)}
.dash-drawer h1{font-size:26px;margin:22px 0 10px}
.dash-drawer h2{margin:24px 0 12px;color:var(--text)}
.dash-drawer pre{white-space:pre-wrap;overflow-wrap:anywhere;background:var(--raised);padding:16px;border-radius:12px;font:12px/1.7 ui-monospace,monospace;max-height:480px;overflow:auto}
.dash-drawer details{border-bottom:1px solid var(--line);padding:16px 0}
.dash-drawer summary{cursor:pointer}
.dash-drawer p{overflow-wrap:anywhere}
.dash-drawer dl{display:grid;grid-template-columns:130px minmax(0,1fr);gap:10px;font-size:12px}
.dash-drawer dd{margin:0;overflow-wrap:anywhere}
.dash-drawer dt{color:var(--muted)}
.dash-task-title{font-weight:500;color:var(--text)}
.dash-tools{max-width:230px;overflow-wrap:anywhere}
.dash-tools summary{white-space:nowrap}
.dash-tools .ts{display:block;max-height:180px;overflow:auto}
.dash-page-title{margin:0 0 12px}
.dash-subtitle{color:var(--muted);line-height:1.7}
.dash-filter{margin:18px 0;display:flex;gap:12px;flex-wrap:wrap}
.dash-filter input{flex:1;min-width:160px;max-width:380px}
.error{background:var(--yellowbg);color:var(--yellow);border-radius:12px;padding:16px}
.live-note{font-size:11px;color:var(--muted);margin:18px 0}
.dash-mini-list{display:grid;gap:12px}
.dash-mini-list button{border-radius:12px;text-align:left;justify-content:space-between;width:100%}
.top-grid{display:block}
.top-grid>div{margin-bottom:24px}
.pty-viewer{margin:24px 0}
.theme-toggle{padding:8px 12px}
.sidebarfoot{font-size:11px;color:var(--muted)}

@media(max-width:1100px){.dash-grid{grid-template-columns:repeat(2,minmax(0,1fr))}
}
@media(max-width:760px){.shell-content{padding:24px 16px}
.dash-grid{gap:12px}
.dash-stat{padding:18px}
.dash-stat strong{font-size:26px}
.meta{display:none}
.topbar{gap:6px}
.topbar h1{font-size:13px}
#top-right{gap:6px}
#refresh-indicator{max-width:88px}
.dash-drawer{padding:22px}
.dash-pager{flex-wrap:wrap}
.sidebar{z-index:90}
.topbar .mobilemenu{z-index:91}
}


/* Shared operational components: bounded columns and theme-aware legacy panels. */
[hidden]{display:none!important}
.identity-badge{display:inline-flex;align-items:center;max-width:100%;padding:4px 9px;border-radius:7px;font-size:11px;font-weight:550;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;background:hsl(var(--agent-hue) 60% 94%);color:hsl(var(--agent-hue) 55% 30%);border:1px solid hsl(var(--agent-hue) 45% 85%)}
[data-theme=dark] .identity-badge{background:hsl(var(--agent-hue) 30% 21%);color:hsl(var(--agent-hue) 65% 80%);border-color:hsl(var(--agent-hue) 30% 35%)}
.channel-badge{display:inline-flex;align-items:center;gap:6px;font-size:11px;color:var(--muted);white-space:nowrap;margin-top:6px}
.channel-badge svg{width:14px;height:14px;flex:none;fill:currentColor}
.table-wrap,.table-scroll{width:100%;max-width:100%;overflow:auto;overscroll-behavior-x:contain;scrollbar-gutter:stable}
.data-table{table-layout:fixed;width:100%;white-space:normal}
.data-table td,.data-table th{padding:14px 16px;vertical-align:top;word-break:normal;overflow-wrap:break-word;font-size:12px}
.data-table th{font-size:10px;white-space:normal}
.data-table .btn-stream{font-size:11px;white-space:nowrap;padding:7px 10px}
.data-table .dash-task-title{white-space:normal;text-align:left;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;border:0;background:none;padding:0;font-size:12px;line-height:1.6;border-radius:0;margin-bottom:8px}
.cell-clip{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%}
.short-id{font:11px ui-monospace,monospace;white-space:nowrap;color:var(--muted)}
.data-table .session-id{word-break:normal;overflow-wrap:normal;font-family:inherit}
.data-table .ts{font-size:10px;line-height:1.6;color:var(--muted)}
.data-table td{font-variant-numeric:tabular-nums}
.dash-tools details{font-size:11px}.dash-tools details[open]{max-width:100%}
.dash-tools .ts{white-space:normal;overflow-wrap:anywhere}
.kb-toolbar,.dream-run,.dream-prop,.proc-tree{background:var(--panel);color:var(--text);border:1px solid var(--line);border-radius:14px;padding:16px}
.kb-toolbar{gap:14px;align-items:center;flex-wrap:wrap}
.kb-toolbar button,.kb-zoom button,.dream-accept-btn,.dream-accept-all,#kb-source,#kb-demo-size,#kb-search,#dreams-agent{font:inherit;font-size:12px;color:var(--text);background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:9px 12px;min-height:38px}
.kb-toolbar button:hover,.kb-zoom button:hover,.dream-accept-btn:hover{background:var(--raised);border-color:var(--accent)}
.kb-stage{background:var(--raised);border-color:var(--line);border-radius:16px}
.dream-run-head .agent,.dream-prop .file,.proc-tree .proc-orchestrator,.proc-tree .proc-mcp{color:var(--accent)}
.dream-run-head .when,.dream-meta,.dreams-empty,.dream-prop .score,.dream-prop .reason,.proc-tree .proc-label,#kb-search-count{color:var(--muted)}
.dream-summary,.dream-prop .content,.dream-prop .anchor{color:var(--text);background:var(--raised)}
.dream-badge.auto,.dream-badge.propose,.dream-badge.outcome{background:var(--raised);color:var(--text);border:1px solid var(--line);border-radius:6px;padding:3px 8px}
.proc-tree .proc-summary,.proc-tree .proc-claude{color:var(--text)}
.proc-tree .proc-pty,.proc-tree .proc-receiver{color:var(--green)}
.proc-tree .proc-orphan{color:var(--red)}
#view-system h2{color:var(--text)}
.proc-tree{white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px;line-height:1.8}
.dream-run-head{gap:10px}.dream-run-head .when{font:11px inherit;margin-left:auto}

.dream-prop .op.add,.prop-status.applied,.prop-status.applied-auto{color:var(--green)}
.dream-prop .op.replace,.dream-prop .anchor,.prop-status.pending{color:var(--accent)}
.dream-prop .op.remove,.prop-status.failed{color:var(--red)}
.dream-accept-all:hover{background:var(--raised)}
.kb-note,.kb-note-head,.kb-note-body{background:var(--panel);color:var(--text);border-color:var(--line)}
`;
export const dashboardFontLink = "<script>(function(){var i=location.pathname.lastIndexOf('/dashboard');if(i<0)return;var l=document.createElement('link');l.rel='stylesheet';l.href=location.pathname.slice(0,i)+'/dashboard/fonts.css';document.head.appendChild(l);})();</script>";
