document.addEventListener("DOMContentLoaded", () => {
"use strict";

const PASSWORD = "isaac0619";

const THEMES  = ["aurora","daylight","obsidian","rose"];
const ACCENTS = [["#8a7cff","#ff8acd"],["#5bc8ff","#7dffb0"],["#ff8a5c","#ffd166"],["#ff6bdc","#8a7cff"],["#5cffc2","#5bc8ff"],["#ffd166","#ff6bdc"]];

const $   = s => document.querySelector(s);
const uid = () => Math.random().toString(36).slice(2,9);
const esc = s => String(s||"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));

/* ---- LOCK SCREEN ---- */
function unlock() {
  const val = $("#lockPassword").value;
  if (val === PASSWORD) {
    $("#lockScreen").style.display = "none";
    $("#app").classList.remove("hidden");
    bootApp();
  } else {
    $("#lockError").classList.remove("hidden");
    $("#lockPassword").value = "";
    $("#lockPassword").focus();
  }
}

$("#lockSubmit").onclick = unlock;
$("#lockPassword").onkeydown = e => { if (e.key === "Enter") unlock(); };
setTimeout(() => $("#lockPassword").focus(), 100);

/* ---- STATE ---- */
const S = { tabs:[], activeId:null, bookmarks:[], files:[], activeFileId:null, cloak:false,
  settings:{theme:"aurora",accent:"#8a7cff",accent2:"#ff8acd",style:"full",glass:60,wisp:"",publicWisp:true} };

const PUBLIC_WISP = "wss://anura.pro/";

let _st;
function save() {
  clearTimeout(_st); _st = setTimeout(async () => {
    try { await fetch("/api/state",{method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({tabs:S.tabs.map(t=>({id:t.id,title:t.title,url:t.url,kind:t.kind})),
        activeId:S.activeId,bookmarks:S.bookmarks,files:S.files,activeFileId:S.activeFileId,cloak:S.cloak,settings:S.settings})}); }catch{}
  }, 350);
}

function defaultFiles() {
  return [
    { id: uid(), name: "index.html", content: `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
</head>
<body>
  <h1>Hello, Universe 🌌</h1>
  <button id="btn">Click me</button>
</body>
</html>` },
    { id: uid(), name: "style.css", content: `body {
  font-family: system-ui, sans-serif;
  display: grid; place-items: center;
  height: 100vh; margin: 0;
  background: #0e0f14; color: #f0f0f0;
}
button {
  margin-top: 16px; padding: 10px 20px;
  border: none; border-radius: 10px;
  background: #8a7cff; color: #fff;
  font-size: 15px; cursor: pointer;
}` },
    { id: uid(), name: "script.js", content: `console.log("Ready!");
document.getElementById("btn").addEventListener("click", () => {
  console.log("Clicked at", new Date().toLocaleTimeString());
  document.querySelector("h1").textContent = "You clicked! ✨";
});` },
  ];
}

async function bootApp() {
  initScramjet();
  try {
    const d = await (await fetch("/api/state")).json();
    if (d.settings) Object.assign(S.settings, d.settings);
    if (d.bookmarks) S.bookmarks = d.bookmarks;
    if (d.files?.length) S.files = d.files;
    if (d.cloak) S.cloak = d.cloak;
    applyTheme();
    if (d.tabs?.length) {
      d.tabs.forEach(t => mkTab(t.url,{title:t.title,id:t.id,silent:true}));
      S.activeId = (d.activeId && S.tabs.find(t=>t.id===d.activeId)) ? d.activeId : S.tabs[0]?.id;
    } else mkTab("",{silent:true});
    if (!S.files.length) S.files=defaultFiles();
    S.activeFileId = (d.activeFileId && S.files.find(f=>f.id===d.activeFileId)) ? d.activeFileId : S.files[0].id;
  } catch {
    applyTheme(); mkTab("",{silent:true});
    S.files=defaultFiles();
    S.activeFileId=S.files[0].id;
  }
  renderAll();
}

/* ---- PROXY (Scramjet SW when available, server /proxy fallback) ---- */
let scramjet = null, scramjetReady = false, activeWisp = "";

// Fetch a URL through the current bare-mux transport; true if it actually works.
async function wispHealthCheck() {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), 9000);
  const res = await fetch(location.origin + scramjet.encodeUrl("https://example.com"), { signal: ctrl.signal }).catch(() => null);
  clearTimeout(to);
  return !!(res && res.ok);
}

async function initScramjet() {
  scramjet = null; scramjetReady = false; activeWisp = "";
  if (!window.isSecureContext || !("serviceWorker" in navigator) || typeof $scramjetLoadController === "undefined") return;
  try {
    const { ScramjetController } = $scramjetLoadController();
    scramjet = new ScramjetController({
      prefix: "/scramjet/",
      files: { wasm: "/scram/scramjet.wasm.wasm", all: "/scram/scramjet.all.js", sync: "/scram/scramjet.sync.js" },
    });
    await scramjet.init();
    await navigator.serviceWorker.register("/sw.js", { scope: "/" });
    await navigator.serviceWorker.ready;
    const conn = new BareMux.BareMuxConnection("/baremux/worker.js");
    const selfHosted = (location.protocol === "https:" ? "wss" : "ws") + "://" + location.host + "/wisp/";
    // Try wisp servers in order and use the first that can actually fetch. A
    // custom server (if set) wins; self-hosted is next; the public wisp is a
    // last resort for networks where self-hosted wisp can't reach targets.
    const candidates = [...new Set([
      S.settings.wisp && S.settings.wisp.trim(),
      selfHosted,
      S.settings.publicWisp !== false ? PUBLIC_WISP : null,
    ].filter(Boolean))];
    for (const wisp of candidates) {
      try {
        await conn.setTransport("/epoxy/index.mjs", [{ wisp }]);
        if (await wispHealthCheck()) {
          scramjetReady = true; activeWisp = wisp;
          console.log("Scramjet proxy ready via", wisp);
          updateWispStatus();
          return;
        }
      } catch { /* try next wisp */ }
    }
    console.warn("Scramjet couldn't fetch on any wisp server; using /proxy fallback");
    scramjet = null;
  } catch (e) {
    console.warn("Scramjet unavailable, using /proxy fallback:", e);
    scramjet = null; scramjetReady = false;
  }
  updateWispStatus();
}

function serverProxy(url) {
  try {
    const b = btoa(unescape(encodeURIComponent(url))).replace(/\+/g,"-").replace(/\//g,"_").replace(/=/g,"");
    return location.origin + "/proxy/" + b;
  } catch { return url; }
}
function toProxy(url) {
  if (scramjetReady && scramjet) {
    try { const e = scramjet.encodeUrl(url); return /^https?:/i.test(e) ? e : location.origin + e; } catch {}
  }
  return serverProxy(url);
}
function resolve(v) {
  const t=(v||"").trim(); if(!t) return null;
  if(/^https?:\/\//i.test(t)) return t;
  if(/^[\w-]+(\.[\w-]+)+([/?#].*)?$/.test(t)&&!t.includes(" ")) return "https://"+t;
  return "https://www.google.com/search?q="+encodeURIComponent(t);
}

/* ---- TABS ---- */
function mkTab(url,o={}) {
  const id=o.id||uid(), tab={id,title:o.title||"New Tab",url:url||"",kind:url?"proxy":"newtab",frame:null};
  S.tabs.push(tab);
  if (url) { mkFrame(tab); loadUrl(tab,url); }
  if (!o.silent) { S.activeId=id; renderAll(); save(); }
  return tab;
}
function mkFrame(tab) {
  if (tab.frame) return;
  const f=document.createElement("iframe"); f.className="view-frame";
  f.setAttribute("allow","fullscreen; clipboard-write");
  f.setAttribute("sandbox","allow-scripts allow-same-origin allow-forms allow-popups allow-top-navigation");
  $("#viewport").appendChild(f); tab.frame=f;
}
function loadUrl(tab,url) { if(!tab.frame) mkFrame(tab); tab.frame.src=toProxy(url); }
function navTab(tab,url) {
  tab.url=url; tab.kind="proxy";
  try { tab.title=new URL(url).hostname.replace(/^www\./,""); } catch { tab.title=url.slice(0,28)||"Tab"; }
  loadUrl(tab,url);
  if(S.activeId===tab.id){ $("#omnibox").value=url; star(); }
  renderTabsList(); save();
}
function closeTab(id) {
  const i=S.tabs.findIndex(t=>t.id===id); if(i<0) return;
  S.tabs[i].frame?.remove(); S.tabs.splice(i,1);
  if(S.activeId===id){ const n=S.tabs[i]||S.tabs[i-1]; S.activeId=n?.id??null; if(!S.tabs.length){ mkTab("",{silent:true}); S.activeId=S.tabs[0].id; } }
  renderAll(); save();
}
function switchTab(id){ S.activeId=id; renderAll(); }
const curTab = () => S.tabs.find(t=>t.id===S.activeId);

/* ---- RENDER ---- */
function renderAll(){ renderTabsList(); renderViewport(); renderBookmarks(); renderFileList(); renderFileTabs(); renderEditor(); }

function renderTabsList(){
  const el=$("#tabsList"); el.innerHTML="";
  S.tabs.forEach(t=>{
    const d=document.createElement("div"); d.className="tab-item"+(t.id===S.activeId?" active":"");
    d.innerHTML=`<span class="tab-fav">${t.kind==="newtab"?"✦":"🌐"}</span><span class="tab-title">${esc(t.title)}</span><span class="tab-close"><svg viewBox="0 0 24 24"><path d="M18 6 6 18M6 6l12 12"/></svg></span>`;
    d.onclick=()=>switchTab(t.id);
    d.querySelector(".tab-close").onclick=e=>{ e.stopPropagation(); closeTab(t.id); };
    el.appendChild(d);
  });
}

function renderViewport(){
  document.querySelectorAll(".newtab").forEach(e=>e.remove());
  S.tabs.forEach(t=>{ if(t.frame) t.frame.classList.toggle("active",t.id===S.activeId); });
  const t=curTab(); if(!t) return;
  $("#omnibox").value=t.url||""; star();
  if(t.kind==="newtab") mkNewTab();
}

function mkNewTab(){
  const pg=document.createElement("div"); pg.className="newtab active";
  pg.innerHTML=`<div class="newtab-logo">Universe</div>
    <form class="newtab-search" id="_ntf">
      <svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>
      <input id="_nti" placeholder="Search Google or type a URL" autocomplete="off" />
    </form>
    <div class="newtab-shortcuts">${S.bookmarks.slice(0,8).map(b=>`<div class="shortcut" data-url="${esc(b.url)}"><div class="shortcut-icon">${esc((b.title||b.url||"?")[0].toUpperCase())}</div><div class="shortcut-label">${esc(b.title||b.url)}</div></div>`).join("")}</div>`;
  $("#viewport").appendChild(pg);
  pg.querySelector("#_ntf").onsubmit=e=>{ e.preventDefault(); go(pg.querySelector("#_nti").value); };
  pg.querySelectorAll(".shortcut").forEach(s=>s.onclick=()=>go(s.dataset.url));
  setTimeout(()=>pg.querySelector("#_nti").focus(),80);
}

function renderBookmarks(){
  const el=$("#bookmarksList"); el.innerHTML="";
  S.bookmarks.forEach(b=>{ const d=document.createElement("div"); d.className="bookmark-item";
    d.innerHTML=`<svg viewBox="0 0 24 24"><path d="m12 2 3.1 6.3 7 1-5 5 1.2 6.9L12 18l-6.3 3.2L7 14.3l-5-5 7-1z"/></svg><span>${esc(b.title||b.url)}</span>`;
    d.onclick=()=>go(b.url); el.appendChild(d); });
}

function star(){ const t=curTab(); $("#starBtn").classList.toggle("starred",!!(t&&S.bookmarks.some(b=>b.url===t.url))); }

/* ---- NAV ---- */
function go(input) {
  const url=resolve(input); if(!url) return;
  let t=curTab();
  if(!t||t.kind==="newtab"){
    if(!t){ mkTab("",{silent:true}); S.activeId=S.tabs[S.tabs.length-1].id; t=curTab(); }
    navTab(t,url); renderViewport();
  } else { navTab(t,url); renderViewport(); }
}

/* ---- TOOLBAR ---- */
$("#omniboxForm").onsubmit=e=>{ e.preventDefault(); go($("#omnibox").value); $("#omnibox").blur(); };
$("#newTabBtn").onclick=()=>mkTab("");
$("#backBtn").onclick=()=>{ try{ curTab()?.frame?.contentWindow?.history.back(); }catch{} };
$("#fwdBtn").onclick=()=>{ try{ curTab()?.frame?.contentWindow?.history.forward(); }catch{} };
$("#reloadBtn").onclick=()=>{ const t=curTab(); if(t?.frame) t.frame.src=t.frame.src; };
$("#starBtn").onclick=()=>{
  const t=curTab(); if(!t?.url) return;
  const i=S.bookmarks.findIndex(b=>b.url===t.url);
  if(i>=0) S.bookmarks.splice(i,1); else S.bookmarks.unshift({url:t.url,title:t.title});
  star(); renderBookmarks(); save();
};
$("#sidebarToggle").onclick=()=>$("#sidebar").classList.toggle("collapsed");
const toggleCode=()=>{
  const p=$("#codePanel"), opening=p.classList.contains("hidden");
  p.classList.toggle("hidden");
  if(opening){ if(!_feRan) runCode(); setTimeout(()=>$("#feEditor").focus(),60); }
};
$("#codePanelToggle").onclick=toggleCode;
$("#codeToggleTop").onclick=toggleCode;
$("#closeCodePanel").onclick=toggleCode;

/* ---- CLOAKERS ---- */
const bHtml=url=>`<!DOCTYPE html><html><head><title></title><style>*{margin:0;padding:0}html,body,iframe{width:100%;height:100%;border:none;overflow:hidden}</style></head><body><iframe src="${url}" allow="fullscreen"></iframe></body></html>`;
$("#cloakerBtn").onclick=()=>{ $("#cloakerPanel").classList.remove("hidden"); };
$("#closeCloakerPanel").onclick=()=>$("#cloakerPanel").classList.add("hidden");
$("#launchBlank").onclick=()=>{ const u=resolve($("#cloakUrl1").value); if(!u) return; const w=window.open("about:blank","_blank"); if(!w){alert("Allow popups");return;} w.document.open(); w.document.write(bHtml(u)); w.document.close(); };
$("#downloadBlank").onclick=()=>{ const u=resolve($("#cloakUrl1").value)||"https://google.com"; const a=document.createElement("a"); a.href=URL.createObjectURL(new Blob([bHtml(u)],{type:"text/html"})); a.download="blank-cloak.html"; a.click(); URL.revokeObjectURL(a.href); };
$("#launchBlob").onclick=()=>{ const u=resolve($("#cloakUrl2").value); if(!u) return; window.open(URL.createObjectURL(new Blob([bHtml(u)],{type:"text/html"})),"_blank"); };
$("#downloadBlob").onclick=()=>{ const u=resolve($("#cloakUrl2").value)||"https://google.com"; const a=document.createElement("a"); a.href=URL.createObjectURL(new Blob([bHtml(u)],{type:"text/html"})); a.download="blob-cloak.html"; a.click(); URL.revokeObjectURL(a.href); };

/* ---- PALETTE ---- */
const cmds=()=>[
  {l:"New tab",k:"Ctrl+T",r:()=>mkTab("")},{l:"Close tab",k:"Ctrl+W",r:()=>{ const t=curTab(); if(t) closeTab(t.id); }},
  {l:"Toggle sidebar",k:"Ctrl+B",r:()=>$("#sidebar").classList.toggle("collapsed")},
  {l:"Toggle code panel",k:"Ctrl+E",r:toggleCode},{l:"Cloakers",k:"",r:()=>$("#cloakerBtn").click()},
  {l:"Customize",k:"Ctrl+,",r:openTheme},{l:"Bookmark page",k:"Ctrl+D",r:()=>$("#starBtn").click()},
  ...S.tabs.map(t=>({l:"Switch: "+t.title,k:"",r:()=>switchTab(t.id)})),
  ...S.bookmarks.map(b=>({l:"Open: "+(b.title||b.url),k:"",r:()=>go(b.url)})),
];
function openPal(){ $("#commandPalette").classList.remove("hidden"); $("#commandInput").value=""; renderCmds(""); setTimeout(()=>$("#commandInput").focus(),10); }
function closePal(){ $("#commandPalette").classList.add("hidden"); }
function renderCmds(q){
  const res=cmds().filter(c=>c.l.toLowerCase().includes(q.toLowerCase())).slice(0,30);
  const box=$("#commandResults"); box.innerHTML="";
  res.forEach((c,i)=>{ const d=document.createElement("div"); d.className="p-result"+(i===0?" sel":"");
    d.innerHTML=`<span>${esc(c.l)}</span>${c.k?`<kbd>${c.k}</kbd>`:""}`;
    d.onclick=()=>{ c.r(); closePal(); }; box.appendChild(d); });
}
$("#commandInput").oninput=e=>renderCmds(e.target.value);
$("#commandInput").onkeydown=e=>{
  if(e.key==="Enter"){ $("#commandResults .p-result.sel")?.click(); }
  if(e.key==="Escape") closePal();
  if(e.key==="ArrowDown"||e.key==="ArrowUp"){
    const items=[...$("#commandResults").querySelectorAll(".p-result")];
    const cur=items.findIndex(el=>el.classList.contains("sel")); items[cur]?.classList.remove("sel");
    items[(e.key==="ArrowDown"?(cur+1):(cur-1+items.length))%items.length]?.classList.add("sel"); e.preventDefault();
  }
};
$("#commandPalette").onclick=e=>{ if(e.target.id==="commandPalette") closePal(); };
$("#commandPaletteBtn").onclick=openPal;

/* ---- THEME ---- */
function applyTheme(){
  document.documentElement.setAttribute("data-theme",S.settings.theme);
  document.documentElement.style.setProperty("--accent",S.settings.accent);
  document.documentElement.style.setProperty("--accent2",S.settings.accent2);
  document.documentElement.style.setProperty("--glass",S.settings.glass);
  document.body.classList.toggle("compact",S.settings.style==="compact");
}
function openTheme(){
  $("#themePanel").classList.remove("hidden");
  const ts=$("#themeSwatches"); ts.innerHTML="";
  THEMES.forEach(t=>{ const d=document.createElement("div"); d.className="swatch"+(S.settings.theme===t?" active":"");
    d.style.background=({aurora:"#111118",daylight:"#eeeaf8",obsidian:"#08080c",rose:"#130e11"})[t]; d.title=t;
    d.onclick=()=>{ S.settings.theme=t; applyTheme(); openTheme(); save(); }; ts.appendChild(d); });
  const as=$("#accentSwatches"); as.innerHTML="";
  ACCENTS.forEach(([a,b])=>{ const d=document.createElement("div"); d.className="swatch"+(S.settings.accent===a?" active":"");
    d.style.background=`linear-gradient(135deg,${a},${b})`;
    d.onclick=()=>{ S.settings.accent=a; S.settings.accent2=b; applyTheme(); openTheme(); save(); }; as.appendChild(d); });
  $("#tabStyleSeg").querySelectorAll("button").forEach(btn=>{
    btn.classList.toggle("active",btn.dataset.val===S.settings.style);
    btn.onclick=()=>{ S.settings.style=btn.dataset.val; applyTheme(); openTheme(); save(); };
  });
  $("#glassRange").value=S.settings.glass;
  $("#glassRange").oninput=e=>{ S.settings.glass=+e.target.value; applyTheme(); save(); };
  $("#wispInput").value=S.settings.wisp||"";
  $("#publicWispToggle").checked=S.settings.publicWisp!==false;
  updateWispStatus();
  $("#wispApply").onclick=async()=>{
    S.settings.wisp=$("#wispInput").value.trim();
    S.settings.publicWisp=$("#publicWispToggle").checked;
    save();
    $("#wispStatus").textContent="Reconnecting…";
    await initScramjet();
    updateWispStatus();
  };
}
function updateWispStatus(){
  const el=$("#wispStatus"); if(!el) return;
  el.classList.toggle("ok",scramjetReady);
  el.textContent=scramjetReady ? ("✓ Scramjet active — "+activeWisp) : "Server /proxy (Scramjet inactive)";
}
$("#themeBtn").onclick=openTheme;
$("#closeThemePanel").onclick=()=>$("#themePanel").classList.add("hidden");

/* ---- CODE EDITOR (DevSpace-style) ---- */
const FE_COLORS={html:"#e34c26",htm:"#e34c26",css:"#264de4",js:"#f7df1e",mjs:"#f7df1e",json:"#6ee7b7",ts:"#3178c6",jsx:"#61dafb",tsx:"#3178c6",py:"#3572a5",md:"#88aa99",svg:"#ff9800",txt:"#9aa"};
const feExt=n=>{ const p=String(n).split("."); return p.length>1?p[p.length-1].toLowerCase():"txt"; };
const feColor=n=>FE_COLORS[feExt(n)]||"#9aa";
const curFile=()=>S.files.find(f=>f.id===S.activeFileId);
let _feErr=0, _feAuto, _feRan=false;

function renderFileList(){
  const list=$("#feFileList"); if(!list) return; list.innerHTML="";
  S.files.forEach(f=>{
    const d=document.createElement("div"); d.className="fe-file"+(f.id===S.activeFileId?" active":"");
    d.innerHTML=`<span class="fe-file-dot" style="background:${feColor(f.name)}"></span><span class="fe-file-name">${esc(f.name)}</span><span class="fe-file-del"><svg viewBox="0 0 24 24"><path d="M18 6 6 18M6 6l12 12"/></svg></span>`;
    d.onclick=()=>openFile(f.id);
    d.querySelector(".fe-file-del").onclick=e=>{ e.stopPropagation(); delFile(f.id); };
    list.appendChild(d);
  });
}
function renderFileTabs(){
  const bar=$("#feTabs"); if(!bar) return; bar.innerHTML="";
  S.files.forEach(f=>{
    const d=document.createElement("div"); d.className="fe-tab"+(f.id===S.activeFileId?" active":"");
    d.innerHTML=`<span class="fe-tab-dot" style="background:${feColor(f.name)}"></span><span>${esc(f.name)}</span>`;
    d.onclick=()=>openFile(f.id);
    bar.appendChild(d);
  });
}
function renderEditor(){ const f=curFile(); if(!f) return; $("#feEditor").value=f.content||""; updateLines(); }
function stashCurrent(){ const f=curFile(), ta=$("#feEditor"); if(f&&ta) f.content=ta.value; }
function openFile(id){ stashCurrent(); S.activeFileId=id; renderFileList(); renderFileTabs(); renderEditor(); save(); if($("#autorunToggle").checked) runCode(); }
function delFile(id){ if(S.files.length<=1) return; const i=S.files.findIndex(f=>f.id===id); S.files.splice(i,1); if(S.activeFileId===id) S.activeFileId=S.files[Math.max(0,i-1)].id; renderFileList(); renderFileTabs(); renderEditor(); save(); }

function updateLines(){
  const ta=$("#feEditor"), ln=$("#feLines"); if(!ta||!ln) return;
  const n=(ta.value.match(/\n/g)||[]).length+1; let h="";
  for(let i=1;i<=n;i++) h+="<span>"+i+"</span>"; ln.innerHTML=h; ln.scrollTop=ta.scrollTop;
}
$("#feEditor").onscroll=()=>{ $("#feLines").scrollTop=$("#feEditor").scrollTop; };
$("#feEditor").oninput=()=>{ stashCurrent(); updateLines(); save(); if($("#autorunToggle").checked){ clearTimeout(_feAuto); _feAuto=setTimeout(runCode,600); } };
$("#feEditor").onkeydown=e=>{ if(e.key==="Tab"){ e.preventDefault(); const ta=e.target,s=ta.selectionStart; ta.value=ta.value.slice(0,s)+"  "+ta.value.slice(ta.selectionEnd); ta.selectionStart=ta.selectionEnd=s+2; stashCurrent(); updateLines(); } };

/* new file */
function showNew(){ $("#feNewRow").classList.remove("hidden"); const i=$("#feNewInp"); i.value=""; i.focus(); }
function hideNew(){ $("#feNewRow").classList.add("hidden"); }
function createFile(){ const inp=$("#feNewInp"), name=inp.value.trim(); if(!name) return;
  if(S.files.some(f=>f.name===name)){ inp.classList.add("shake"); setTimeout(()=>inp.classList.remove("shake"),400); return; }
  const f={id:uid(),name,content:""}; S.files.push(f); hideNew(); S.activeFileId=f.id; renderFileList(); renderFileTabs(); renderEditor(); save(); }
$("#feAddBtn").onclick=showNew;
$("#feCreateBtn").onclick=createFile;
$("#feCancelBtn").onclick=hideNew;
$("#feNewInp").onkeydown=e=>{ if(e.key==="Enter") createFile(); if(e.key==="Escape") hideNew(); };

/* build a combined runnable document from html/css/js files */
function buildDoc(withConsole){
  stashCurrent();
  const hf=S.files.find(f=>["html","htm"].includes(feExt(f.name)));
  const cf=S.files.find(f=>feExt(f.name)==="css");
  const jf=S.files.find(f=>feExt(f.name)==="js");
  const h=hf?hf.content:"", c=cf?cf.content:"", j=jf?jf.content:"";
  const fix='<style>html,body{height:auto!important;overflow:auto!important}</style>';
  const cap=withConsole?'<scr'+'ipt>(function(){var _c=["log","warn","error","info","debug"];_c.forEach(function(m){var o=console[m].bind(console);console[m]=function(){var a=[].slice.call(arguments).map(function(x){try{return typeof x==="object"?JSON.stringify(x,null,2):String(x);}catch(e){return String(x);}}).join(" ");parent.postMessage({type:"fe-console",method:m,message:a},"*");o.apply(console,arguments);};});window.onerror=function(msg,s,l){parent.postMessage({type:"fe-console",method:"error",message:msg+(l?" (line "+l+")":"")},"*");};})();</scr'+'ipt>':"";
  const head=fix+cap+"<style>"+c+"</style>";
  const bodyJs="<scr"+"ipt>"+j+"</scr"+"ipt>";
  let doc;
  if(/<html|<!doctype/i.test(h)){
    doc=h;
    doc=/<\/head>/i.test(doc)?doc.replace(/<\/head>/i,head+"</head>"):head+doc;
    doc=/<\/body>/i.test(doc)?doc.replace(/<\/body>/i,bodyJs+"</body>"):doc+bodyJs;
  } else {
    doc='<!DOCTYPE html><html><head><meta charset="UTF-8">'+head+"</head><body>"+h+bodyJs+"</body></html>";
  }
  return doc;
}
function runCode(){
  _feRan=true;
  clearConsole();
  const blob=new Blob([buildDoc(true)],{type:"text/html"}), u=URL.createObjectURL(blob);
  const fr=$("#fePreview"); fr.onload=()=>URL.revokeObjectURL(u); fr.src=u;
}
window.addEventListener("message",e=>{ if(e.data&&e.data.type==="fe-console") addConsole(e.data.method,e.data.message); });
function addConsole(m,msg){
  const out=$("#feConsole"); const em=out.querySelector(".c-empty"); if(em) em.remove();
  const icons={log:"›",warn:"!",error:"✕",info:"i",debug:"•"};
  const el=document.createElement("div"); el.className="c-line "+(m==="debug"?"log":m);
  el.innerHTML=`<span class="c-icon">${icons[m]||"›"}</span><span>${esc(msg)}</span>`;
  out.appendChild(el); out.scrollTop=out.scrollHeight;
  if(m==="error"){ _feErr++; const b=$("#feErrBadge"); b.textContent=_feErr; b.classList.add("show"); }
}
function clearConsole(){ _feErr=0; const b=$("#feErrBadge"); b.classList.remove("show"); b.textContent=""; $("#feConsole").innerHTML='<div class="c-empty">Console output will appear here…</div>'; }
$("#runBtn").onclick=runCode;
$("#feClearConsole").onclick=clearConsole;
$("#autorunToggle").onchange=e=>{ if(e.target.checked) runCode(); };

/* download / save / cloak */
function dlFile(content,name,mime){ const a=document.createElement("a"); a.href=URL.createObjectURL(new Blob([content],{type:mime||"text/plain"})); a.download=name; a.click(); setTimeout(()=>URL.revokeObjectURL(a.href),120); }
$("#dlBtn").onclick=()=>{ stashCurrent(); const map={html:"text/html",css:"text/css",js:"application/javascript",json:"application/json"};
  S.files.forEach((f,i)=>setTimeout(()=>dlFile(f.content||"",f.name.split("/").pop(),map[feExt(f.name)]||"text/plain"),i*250)); };
$("#saveAppBtn").onclick=async()=>{ try{ const r=await fetch(location.href); const b=await r.blob(); const a=document.createElement("a"); a.href=URL.createObjectURL(b); a.download="universe.html"; a.click(); setTimeout(()=>URL.revokeObjectURL(a.href),120); }catch{} };
$("#cloakCodeBtn").onclick=()=>{ const w=window.open("about:blank","_blank"); if(!w){ alert("Allow popups"); return; } w.document.open(); w.document.write(buildDoc(false)); w.document.close(); };

/* ---- KEYBOARD ---- */
document.onkeydown=e=>{
  if(e.key==="Escape"){ closePal(); ["themePanel","cloakerPanel"].forEach(id=>$("#"+id).classList.add("hidden")); return; }
  const mod=e.ctrlKey||e.metaKey; if(!mod) return; const k=e.key.toLowerCase();
  const map={t:()=>mkTab(""),w:()=>{ const t=curTab(); if(t) closeTab(t.id); },l:()=>{ $("#omnibox").focus(); $("#omnibox").select(); },k:openPal,b:()=>$("#sidebar").classList.toggle("collapsed"),e:toggleCode,d:()=>$("#starBtn").click(),r:()=>$("#reloadBtn").click(),",":openTheme};
  if(map[k]){ e.preventDefault(); map[k](); return; }
  if(/^[1-9]$/.test(k)){ const t=S.tabs[+k-1]; if(t){ e.preventDefault(); switchTab(t.id); } }
  if(k==="tab"){ e.preventDefault(); const i=S.tabs.findIndex(t=>t.id===S.activeId); switchTab(S.tabs[(e.shiftKey?(i-1+S.tabs.length):i+1)%S.tabs.length].id); }
};

});