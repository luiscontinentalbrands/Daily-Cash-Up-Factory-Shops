import { firebaseConfig, AI_MODEL, APP_CHECK_SITE_KEY } from "./firebase-config.js?v=2026-10-13e";
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.17.1/firebase-app.js";
import { initializeAppCheck, ReCaptchaEnterpriseProvider } from "https://www.gstatic.com/firebasejs/12.17.1/firebase-app-check.js";
import { getFirestore, doc as fdoc, getDocs, setDoc, updateDoc, addDoc, collection, query, where, orderBy, limit, onSnapshot, serverTimestamp } from "https://www.gstatic.com/firebasejs/12.17.1/firebase-firestore.js";

/* ---------- constants & helpers ---------- */
const METHODS=[
  {k:"cash",l:"Cash"},{k:"cashguard",l:"CashGuard"},{k:"card",l:"Credit card"},
  {k:"eft",l:"EFT"},{k:"shop2shop",l:"Shop2Shop"},{k:"snapscan",l:"SnapScan"}
];
const DEPTS={wholesale:"Wholesale",retail:"Retail",manager:"Manager"};
const fmt=new Intl.NumberFormat("en-ZA",{minimumFractionDigits:2,maximumFractionDigits:2});
const R=v=>"R "+fmt.format(v||0);
const RV=v=>{const a=Math.round(v*100)/100;if(a===0)return "R 0.00";return (a>0?"+":"−")+"R "+fmt.format(Math.abs(a));};
const vcls=v=>{const a=Math.round(v*100)/100;return a===0?"var-zero":a>0?"var-pos":"var-neg";};
const num=s=>{if(s===""||s==null)return 0;const n=parseFloat(String(s).replace(/[^0-9.\-]/g,""));return isFinite(n)?n:0;};
const esc=s=>String(s==null?"":s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const safeImg=s=>/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(String(s||""))?s:"";
function todayStr(){const d=new Date();return d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-"+String(d.getDate()).padStart(2,"0");}
function longDate(s){const [y,m,d]=s.split("-").map(Number);return new Date(y,m-1,d).toLocaleDateString("en-ZA",{weekday:"long",day:"numeric",month:"long",year:"numeric"});}
function shortDate(s){const [y,m,d]=s.split("-").map(Number);return new Date(y,m-1,d).toLocaleDateString("en-ZA",{weekday:"short",day:"numeric",month:"short",year:"numeric"});}
function timeStr(iso){if(!iso)return "";try{return new Date(iso).toLocaleString("en-ZA",{day:"numeric",month:"short",hour:"2-digit",minute:"2-digit"});}catch(e){return "";}}
function clone(o){return JSON.parse(JSON.stringify(o));}

function blank(date,dept){const lines={};METHODS.forEach(m=>lines[m.k]={report:"",deposited:""});
  return {date,dept,cashier:"",lines,damaged:"",damagedNotes:"",notes:"",status:"new",signature:"",signedBy:"",signedAt:"",updatedAt:""};}
function normalize(raw,date,dept){const b=blank(date,dept);if(!raw)return b;const r=Object.assign({},raw);
  // trust the server clock for signature times, not the phone's
  if(raw.signedAtServer&&typeof raw.signedAtServer.toDate==="function")r.signedAt=raw.signedAtServer.toDate().toISOString();
  delete r.signedAtServer;delete r.updatedAtServer;delete r.reopenedAt;
  const o=Object.assign(b,clone(r));METHODS.forEach(m=>{o.lines[m.k]=Object.assign({report:"",deposited:""},(raw.lines||{})[m.k]||{});});return o;}
function totals(doc){let r=0,d=0;METHODS.forEach(m=>{r+=num(doc.lines[m.k].report);d+=num(doc.lines[m.k].deposited);});return {report:r,deposited:d,variance:d-r};}

/* Deadline: every trading day Mon–Sat, all three signatures by 19:00 */
function dayInfo(date,W,Rt,M){const [y,m,d]=date.split("-").map(Number);const dt=new Date(y,m-1,d);
  if(dt.getDay()===0)return {kind:"sunday",label:"Sunday · not a trading day",cls:"",missing:[]};
  const dl=new Date(y,m-1,d,19,0,0);const missing=[];
  if(!(W&&W.status==="signed"))missing.push("Wholesale");if(!(Rt&&Rt.status==="signed"))missing.push("Retail");if(!(M&&M.status==="signed"))missing.push("Manager");
  if(!missing.length){const last=Math.max(...[W,Rt,M].map(x=>Date.parse(x.signedAt)||0));
    return last>dl.getTime()?{kind:"late",label:"Completed late · "+timeStr(new Date(last).toISOString()),cls:"draft",missing}:{kind:"done",label:"Completed on time",cls:"signed",missing};}
  const now=Date.now();
  if(now>dl.getTime())return {kind:"overdue",label:"Overdue · missing "+missing.join(", "),cls:"bad",missing};
  const mins=Math.round((dl.getTime()-now)/60000);
  return {kind:"open",label:mins<24*60?`Due by 7 pm · ${Math.floor(mins/60)}h ${mins%60}m left`:"Due by 7 pm on "+shortDate(date),cls:"draft",missing};}

/* ---------- Firebase ---------- */
const $=s=>document.querySelector(s);
const main=$("#main");
const configured=!String(firebaseConfig.apiKey||"").startsWith("PASTE");
let app,db;
if(configured){app=initializeApp(firebaseConfig);
  // App Check proves requests come from this app (Google requires it for the photo reader)
  if(APP_CHECK_SITE_KEY&&!String(APP_CHECK_SITE_KEY).startsWith("PASTE")){try{initializeAppCheck(app,{provider:new ReCaptchaEnterpriseProvider(APP_CHECK_SITE_KEY),isTokenAutoRefreshEnabled:true});}catch(e){console.error("App Check:",e);}}
  db=getFirestore(app);}

const state={date:todayStr(),tab:"wholesale",docs:{wholesale:null,retail:null,manager:null},history:[],pending:{},key:null,ready:false,users:[],me:null};
const local={};let daySub=null,histSub=null,photoSub=null,timers={};
state.photos=[];

/* ---------- device access code ----------
   The shop's secret code is given once per device through a setup link (…/#join-CODE).
   The device remembers it; the database refuses anything that does not carry the right code. */
const KEY_RE=/^[A-Za-z0-9]{16,64}$/;
function readKey(){try{return localStorage.getItem("cu_key");}catch(e){return null;}}
function saveKey(k){try{localStorage.setItem("cu_key",k);}catch(e){}}
function forgetKey(){try{localStorage.removeItem("cu_key");}catch(e){}}
(function takeKeyFromLink(){const h=location.hash||"";const m=h.match(/^#join-([A-Za-z0-9]{16,64})$/);
  if(m){saveKey(m[1]);history.replaceState(null,"",location.pathname+location.search);}})();
const shopCol=()=>collection(db,"shops",state.key,"cashups");
const shopDoc=id=>fdoc(db,"shops",state.key,"cashups",id);
const usersCol=()=>collection(db,"shops",state.key,"users");
const photosCol=()=>collection(db,"shops",state.key,"photos");
const ROLE_LABEL={wholesale:"Wholesale cashier",retail:"Retail cashier",manager:"Manager",admin:"Administrator"};
async function pinHash(salt,pin){const b=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(salt+":"+pin));
  return Array.from(new Uint8Array(b)).map(x=>x.toString(16).padStart(2,"0")).join("");}
function newSalt(){const a=new Uint8Array(16);crypto.getRandomValues(a);return Array.from(a).map(x=>x.toString(16).padStart(2,"0")).join("");}
const role=()=>state.me&&state.me.role;
const canEditDept=d=>[d,"manager","admin"].includes(role());
const canSignDept=d=>[d,"admin"].includes(role());
const canSignManager=()=>["manager","admin"].includes(role());

if(!configured){
  main.innerHTML=`<div class="login sheet" style="padding:22px"><h2>Setup needed</h2><div class="msg">Firebase is not connected yet. Fill in <b>firebase-config.js</b> with your Firebase project settings, as described in the README.</div></div>`;
}else{
  const k=readKey();
  if(k&&KEY_RE.test(k))checkKey(k);else showSetup();
}

function showSetup(msg){
  $("#tabs").hidden=true;$("#datebox").hidden=true;$("#who").hidden=true;$("#foot").textContent="";
  main.innerHTML=`<form class="login sheet" id="keyform" style="padding:22px" novalidate>
    <div><div class="eyebrow">Set up this device</div><h2>Factory Shop Cash Up</h2></div>
    <div class="msg">Open the setup link your manager sent you on this device, or type the shop access code below (a long code of letters and numbers, not your PIN). You only do this once per device. Your PIN comes on the next screen.</div>
    <div class="field"><label for="keyin">Shop access code</label><input id="keyin" autocomplete="off" autocapitalize="off" spellcheck="false"></div>
    <button class="btn primary" type="submit" id="keybtn">Set up this device</button>
    <div class="msg ${msg?"err":""}" id="keymsg">${esc(msg||"")}</div>
  </form>`;
  $("#keyform").addEventListener("submit",e=>{e.preventDefault();const v=$("#keyin").value.trim();
    if(!KEY_RE.test(v)){const m=$("#keymsg");m.className="msg err";m.textContent=/^\d{3,8}$/.test(v)?"This box needs the shop access code (a long code of letters and numbers), not your PIN. You enter your PIN on the next screen.":"That code is not valid. Check it and try again.";return;}
    $("#keybtn").disabled=true;checkKey(v);});
}
async function checkKey(k){
  state.key=k;main.innerHTML=`<div class="empty-state">Connecting…</div>`;
  try{await getDocs(query(collection(db,"shops",k,"cashups"),limit(1)));
    saveKey(k);loadUsersThenWho();}
  catch(e){state.key=null;
    console.error("checkKey:",e);const det=" ("+String(e&&(e.code||e.message)||e).slice(0,120)+")";
    if(e&&e.code==="permission-denied")showSetup("This access code was not accepted. Type the shop access code again, or ask your manager for the setup link."+det);
    else showSetup("Could not reach the database. Check the internet connection and try again."+det);}
}
let usersSub=null;
function loadUsersThenWho(){
  if(usersSub)usersSub();let first=true;
  usersSub=onSnapshot(usersCol(),snap=>{
    state.users=snap.docs.map(d=>Object.assign({id:d.id},d.data())).filter(u=>u.deleted!==true).sort((x,y)=>String(x.name).localeCompare(String(y.name)));
    if(state.me){const u=state.users.find(x=>x.id===state.me.id);
      if(!u&&state.me.id===state.justCreated)return;
      if(!u||u.active!==true){lockApp("Your user was switched off by the administrator.");return;}
      state.me=u;whoBar();}
    if(first){first=false;
      let saved=null;try{saved=sessionStorage.getItem("cu_me");}catch(e){}
      const u=saved&&state.users.find(x=>x.id===saved&&x.active===true);
      if(u){state.me=u;startApp();}else showWho();}
    else if(!state.me&&!$("#pinform")&&!$("#pinchange"))showWho();
    if(state.tab==="users"&&state.ready)render();
  },()=>showSetup("Could not load the list of users. Check the connection and reload."));
}
function showWho(msg){
  stopSubs();state.ready=false;state.me=null;try{sessionStorage.removeItem("cu_me");}catch(e){}
  $("#tabs").hidden=true;$("#datebox").hidden=true;$("#who").hidden=true;$("#foot").textContent="";
  const active=state.users.filter(u=>u.active===true);
  if(!state.users.length){showFirstAdmin();return;}
  main.innerHTML=`<div class="login sheet" style="padding:22px">
    <div><div class="eyebrow">Who is using the app?</div><h2>Factory Shop Cash Up</h2></div>
    <div class="msg ${msg?"err":""}">${esc(msg||"Tap your name, then enter your PIN.")}</div>
    <div class="actions" style="flex-direction:column;align-items:stretch">${active.map(u=>`<button class="btn" data-u="${esc(u.id)}" type="button" style="text-align:left;display:flex;justify-content:space-between;gap:10px"><span>${esc(u.name)}</span><span class="msg">${esc(ROLE_LABEL[u.role]||"")}</span></button>`).join("")||'<div class="msg">No active users. Ask the administrator.</div>'}</div>
  </div>`;
  main.querySelectorAll("button[data-u]").forEach(b=>b.addEventListener("click",()=>askPin(state.users.find(u=>u.id===b.dataset.u))));
}
function askPin(u){if(!u)return;
  main.innerHTML=`<form class="login sheet" id="pinform" style="padding:22px" novalidate>
    <div><div class="eyebrow">${esc(ROLE_LABEL[u.role]||"")}</div><h2>${esc(u.name)}</h2></div>
    <div class="field"><label for="pin">PIN</label><input id="pin" type="password" inputmode="numeric" autocomplete="off" maxlength="6" style="font-size:1.4rem;letter-spacing:.4em;text-align:center"></div>
    <button class="btn primary" type="submit">Enter</button>
    <button class="linkbtn" type="button" id="back">Not you? Go back</button>
    <div class="msg" id="pinmsg"></div></form>`;
  const p=$("#pin");p.focus();
  $("#back").addEventListener("click",()=>showWho());
  $("#pinform").addEventListener("submit",async e=>{e.preventDefault();const m=$("#pinmsg");
    const now=Date.now();state.tries=(state.tries||[]).filter(t=>now-t<5*60000);
    if(state.tries.length>=5){m.className="msg err";m.textContent="Too many wrong PINs. Wait 5 minutes and try again.";return;}
    if(await pinHash(u.salt,p.value)===u.pinHash){state.tries=[];
      if(u.mustChange===true){showChangePin(u,true);return;}
      state.me=u;try{sessionStorage.setItem("cu_me",u.id);}catch(x){}startApp();}
    else{state.tries.push(now);m.className="msg err";m.textContent="Wrong PIN. Try again.";p.value="";p.focus();}});
}
// Change PIN: forced after the administrator sets a PIN, or by choice from the top bar
function showChangePin(u,forced){
  main.innerHTML=`<form class="login sheet" id="pinchange" style="padding:22px" novalidate>
    <div><div class="eyebrow">${esc(u.name)}</div><h2>${forced?"Choose your own PIN":"Change my PIN"}</h2></div>
    ${forced?'<div class="msg">Your PIN was set by the administrator. Choose a new 4-digit PIN that only you know.</div>':'<div class="field"><label for="cp0">Current PIN</label><input id="cp0" type="password" inputmode="numeric" maxlength="6" autocomplete="off"></div>'}
    <div class="field"><label for="cp1">New 4-digit PIN</label><input id="cp1" type="password" inputmode="numeric" maxlength="4" autocomplete="off"></div>
    <div class="field"><label for="cp2">Type the new PIN again</label><input id="cp2" type="password" inputmode="numeric" maxlength="4" autocomplete="off"></div>
    <button class="btn primary" type="submit" id="cpbtn">Save new PIN</button>
    <button class="linkbtn" type="button" id="cpback">${forced?"Not now, go back":"Cancel"}</button>
    <div class="msg" id="cpmsg"></div></form>`;
  const first=forced?$("#cp1"):$("#cp0");first.focus();
  $("#cpback").addEventListener("click",()=>{if(forced)showWho();else render();});
  $("#pinchange").addEventListener("submit",async e=>{e.preventDefault();const m=$("#cpmsg");m.className="msg err";
    const a=$("#cp1").value,b=$("#cp2").value;
    if(!forced){const now=Date.now();state.tries=(state.tries||[]).filter(t=>now-t<5*60000);
      if(state.tries.length>=5){m.textContent="Too many wrong PINs. Wait 5 minutes and try again.";return;}
      if(await pinHash(u.salt,$("#cp0").value)!==u.pinHash){state.tries.push(now);m.textContent="The current PIN is wrong.";return;}}
    if(!/^\d{4}$/.test(a)){m.textContent="The new PIN must be exactly 4 digits.";return;}
    if(a!==b){m.textContent="The two new PINs are not the same.";return;}
    if(/^(\d)\1{3}$/.test(a)||a==="1234"){m.textContent="That PIN is too easy to guess. Choose another.";return;}
    if(await pinHash(u.salt,a)===u.pinHash){m.textContent="Choose a PIN different from the old one.";return;}
    $("#cpbtn").disabled=true;
    try{const salt=newSalt(),pinHashV=await pinHash(salt,a);
      await setDoc(fdoc(usersCol(),u.id),{salt,pinHash:pinHashV,mustChange:false,pinChangedAt:serverTimestamp()},{merge:true});
      const me=Object.assign({},u,{salt,pinHash:pinHashV,mustChange:false});
      if(forced){state.me=me;try{sessionStorage.setItem("cu_me",me.id);}catch(x){}startApp();}
      else{state.me=me;render();}
}
    catch(x){$("#cpbtn").disabled=false;m.textContent="Could not save. Check the connection and try again.";}});
}
function showFirstAdmin(){
  main.innerHTML=`<form class="login sheet" id="adminform" style="padding:22px" novalidate>
    <div><div class="eyebrow">First-time setup</div><h2>Create the administrator</h2></div>
    <div class="msg">This is you. As administrator you add the cashiers and managers in the app, under Users.</div>
    <div class="field"><label for="an">Full name</label><input id="an" maxlength="60" autocomplete="name"></div>
    <div class="field"><label for="ap">Choose a 4-digit PIN</label><input id="ap" type="password" inputmode="numeric" maxlength="4" autocomplete="off"></div>
    <div class="field"><label for="ap2">Type the PIN again</label><input id="ap2" type="password" inputmode="numeric" maxlength="4" autocomplete="off"></div>
    <button class="btn primary" type="submit" id="abtn">Create administrator</button>
    <div class="msg" id="amsg"></div></form>`;
  $("#adminform").addEventListener("submit",async e=>{e.preventDefault();const m=$("#amsg");m.className="msg err";
    const n=$("#an").value.trim(),p=$("#ap").value,p2=$("#ap2").value;
    if(n.length<3){m.textContent="Type your full name.";return;}
    if(!/^\d{4}$/.test(p)){m.textContent="The PIN must be exactly 4 digits.";return;}
    if(p!==p2){m.textContent="The two PINs do not match.";return;}
    $("#abtn").disabled=true;
    try{const salt=newSalt();const ref=fdoc(usersCol());const h=await pinHash(salt,p);
      state.me={id:ref.id,name:n,role:"admin",active:true};state.justCreated=ref.id;
      await setDoc(ref,{name:n,role:"admin",active:true,salt,pinHash:h,createdAt:serverTimestamp()});
      try{sessionStorage.setItem("cu_me",ref.id);}catch(x){}startApp();}
    catch(x){state.me=null;state.justCreated=null;$("#abtn").disabled=false;m.textContent="Could not save. Check the connection and try again.";}});
}
function whoBar(){const w=$("#who");w.hidden=false;
  w.innerHTML=`<b>${esc(state.me.name)}</b><span class="roletag">${esc(ROLE_LABEL[role()]||"")}</span><button id="mypin" type="button">Change PIN</button><button id="switchu" type="button">Switch user</button>`;
  $("#switchu").addEventListener("click",()=>{flushAll();showWho();});
  $("#mypin").addEventListener("click",()=>{flushAll();showChangePin(state.me,false);});
  $("#tab-users").hidden=role()!=="admin";}
function lockApp(msg){flushAll();showWho(msg);}
let idleT=null;
function resetIdle(){clearTimeout(idleT);if(state.me)idleT=setTimeout(()=>lockApp("Locked after 15 minutes without use. Tap your name to continue."),15*60000);}
["pointerdown","keydown"].forEach(ev=>document.addEventListener(ev,resetIdle,{passive:true}));

/* ---------- app start ---------- */
function startApp(){
  $("#tabs").hidden=false;$("#datebox").hidden=false;whoBar();state.ready=true;resetIdle();
  $("#foot").textContent="Live sync active · shared by all cashiers · App version 2026-10-13e";
  const r=role();state.tab=r==="retail"?"retail":r==="manager"?"combined":"wholesale";
  if(state.tab==="users"&&r!=="admin")state.tab="wholesale";
  state.date=todayStr();$("#date").value=state.date;
  Object.keys(local).forEach(k=>delete local[k]);
  subscribeDay();subscribeHistory();setTab(state.tab);
}
$("#date").addEventListener("change",e=>{if(e.target.value)setDate(e.target.value);});
$("#today").addEventListener("click",()=>{$("#date").value=todayStr();setDate(todayStr());});
document.querySelectorAll("nav.tabs button").forEach(b=>b.addEventListener("click",()=>setTab(b.dataset.tab)));
function setTab(t){if(t==="users"&&role()!=="admin")t="wholesale";state.tab=t;document.querySelector("header.bar").classList.toggle("dept-wholesale",t==="wholesale");document.querySelector("header.bar").classList.toggle("dept-retail",t==="retail");
  document.querySelectorAll("nav.tabs button").forEach(b=>b.setAttribute("aria-selected",String(b.dataset.tab===t)));render(true);}
function setDate(d){flushAll();state.date=d;state.docs={wholesale:null,retail:null,manager:null};delete local.wholesale;delete local.retail;delete local.manager;subscribeDay();render(true);}
function stopSubs(){if(photoSub){photoSub();photoSub=null;}if(daySub){daySub();daySub=null;}if(histSub){histSub();histSub=null;}}

function canReopen(dept){if(dept==="manager")return canSignManager();if(["manager","admin"].includes(role()))return current("manager").status!=="signed";return current(dept).signedBy===state.me.name&&current("manager").status!=="signed";}
function current(dept){if(!local[dept])local[dept]=normalize(state.docs[dept],state.date,dept);return local[dept];}
function statusOf(doc){if(!doc)return "new";return doc.status==="signed"?"signed":(doc.status==="draft"?"draft":"new");}
function chip(st){return st==="signed"?'<span class="chip signed">Signed off</span>':st==="draft"?'<span class="chip draft">In progress</span>':'<span class="chip">Not started</span>';}
function updateDots(){["wholesale","retail"].forEach(d=>{const st=statusOf(local[d]||state.docs[d]);$("#dot-"+d).className="dot "+(st==="new"?"":st);});}

/* ---------- persistence ---------- */
function idOf(dept,date){return (date||state.date)+"_"+dept;}
function scheduleSave(dept){const doc=local[dept];if(doc.status==="new")doc.status="draft";
  if(dept!=="manager"&&!doc.cashier)doc.cashier=state.me.name;
  state.ver=state.ver||{};state.ver[dept]=(state.ver[dept]||0)+1;
  state.pending[dept]=true;clearTimeout(timers[dept]);setSaved(dept,"Saving…");
  timers[dept]=setTimeout(()=>save(dept),700);updateDots();}
function flushAll(){Object.keys(timers).forEach(d=>{if(state.pending[d]){clearTimeout(timers[d]);save(d);}});}
function payload(doc,signing,reopening){const p=clone(doc);
  p.updatedAt=new Date().toISOString();p.updatedAtServer=serverTimestamp();
  p.reopenedAt=reopening?serverTimestamp():null;
  if(signing)p.signedAtServer=serverTimestamp();
  else if(p.status!=="signed")p.signedAtServer=null;
  return p;}
async function save(dept,opts){opts=opts||{};const doc=local[dept];if(!doc)return false;
  state.ver=state.ver||{};const v=state.ver[dept]||0;state.inflight=state.inflight||{};state.inflight[dept]=(state.inflight[dept]||0)+1;
  try{await setDoc(shopDoc(idOf(dept,doc.date)),payload(doc,!!opts.signing,opts.action==="reopened"));
    state.inflight[dept]--;
    // only release the lock if nothing newer was typed while this save was on its way
    if((state.ver[dept]||0)===v&&!state.inflight[dept])state.pending[dept]=false;
    setSaved(dept,(state.pending[dept]?"Saving…":"Saved for everyone · "+timeStr(new Date().toISOString())));
    {const b=document.getElementById("savealert");if(b)b.hidden=true;}
    if(opts.action){try{await addDoc(collection(db,"shops",state.key,"cashups",idOf(dept,doc.date),"history"),{name:String(opts.by||doc.signedBy||"").slice(0,80),action:opts.action,at:serverTimestamp(),totals:dept==="manager"?null:totals(doc)});}catch(e){}}
    return true;}
  catch(e){state.inflight[dept]--;state.pending[dept]=false;console.error("Save failed:",e);
    const why=e&&e.code==="permission-denied"?"The database refused to save it (permission-denied). The Firebase rules may be out of date.":"Could not reach the database ("+(e&&(e.code||e.message)||"unknown")+"). Check the connection.";
    setSaved(dept,"NOT SAVED. "+why,true);saveAlert("Your last change was NOT saved. "+why);
    return false;}}
function saveAlert(t){let b=document.getElementById("savealert");
  if(!b){b=document.createElement("div");b.id="savealert";b.setAttribute("role","alert");
    b.style.cssText="position:fixed;left:16px;right:16px;bottom:calc(16px + env(safe-area-inset-bottom,0px));z-index:40;background:var(--bad);color:#fff;padding:12px 16px;border-radius:12px;font-weight:600;box-shadow:0 10px 30px rgba(0,0,0,.25)";
    document.body.appendChild(b);}
  b.textContent=t;b.hidden=false;clearTimeout(b._t);b._t=setTimeout(()=>{b.hidden=true;},20000);}
function setSaved(dept,t,err){const el=document.getElementById("saved-"+dept)||document.getElementById("sign-msg");if(el){el.textContent=t;el.className=(el.id==="sign-msg"?"msg":"saved")+(err?" msg err":"");}}

function subscribeDay(){if(daySub){daySub();daySub=null;}
  const date=state.date;
  if(photoSub){photoSub();photoSub=null;}state.photos=[];
  photoSub=onSnapshot(query(photosCol(),where("date","==",date)),snap=>{if(date!==state.date)return;
    state.photos=snap.docs.map(d=>Object.assign({id:d.id},d.data())).sort((a,b)=>String(a.takenAt||"").localeCompare(String(b.takenAt||"")));
    document.querySelectorAll("[data-photos]").forEach(el=>{el.innerHTML=photoStrip(el.dataset.photos);bindThumbs(el);});},()=>{});
  daySub=onSnapshot(query(shopCol(),where("date","==",date)),snap=>{
    if(date!==state.date)return;
    const got={wholesale:null,retail:null,manager:null};
    snap.docs.forEach(d=>{const v=d.data();if(v&&Object.prototype.hasOwnProperty.call(got,v.dept))got[v.dept]=v;});
    let needRender=false;
    ["wholesale","retail","manager"].forEach(dept=>{
      state.docs[dept]=got[dept];
      if(state.pending[dept]){
        // someone signed this sheet while we had unsaved typing: drop our stale draft
        if(got[dept]&&got[dept].status==="signed"&&local[dept]&&local[dept].status!=="signed"){clearTimeout(timers[dept]);state.pending[dept]=false;}
        else return;}
      const fresh=normalize(got[dept],date,dept);
      if(!local[dept]||JSON.stringify(fresh)!==JSON.stringify(local[dept])){
        const statusChanged=!local[dept]||local[dept].status!==fresh.status;
        local[dept]=fresh;
        if(state.tab===dept){if(statusChanged||!main.contains(document.activeElement))needRender=true;else patchInputs(dept);}
        else needRender=true;
      }});
    updateDots();if(needRender)render();
  },()=>{$("#foot").textContent="Live sync stopped. Reload the page to reconnect.";});}
function subscribeHistory(){if(histSub){histSub();histSub=null;}
  histSub=onSnapshot(query(shopCol(),orderBy("date","desc"),limit(240)),snap=>{
    state.history=snap.docs.map(d=>d.data());if(state.tab==="history")render();},()=>{});}

/* ---------- rendering ---------- */
function render(force){if(!state.ready)return;updateDots();
  const pd=document.getElementById("pad");if(!force&&pd&&pd.dataset.inked==="1"){state.deferred=true;return;}
  state.deferred=false;
  if(state.tab==="users"){renderUsers();return;}
  if(state.tab==="wholesale"||state.tab==="retail")renderDept(state.tab);
  else if(state.tab==="combined")renderCombined();else renderHistory();}

function banner(di){if(di.kind==="sunday")return "";
  return `<div class="banner ${di.kind==="done"?"ok":di.kind==="overdue"?"bad":"wait"}" style="font-weight:500">${di.kind==="overdue"?"Past the 7 pm deadline. Missing: "+di.missing.join(", ")+".":di.kind==="open"?di.label+". Wholesale, Retail and the Manager must all sign.":di.label+"."}</div>`;}

function renderDept(dept){
  const doc=current(dept),signed=doc.status==="signed",editable=!signed&&canEditDept(dept),dis=editable?"":"disabled";
  const t=totals(doc);
  const rows=METHODS.map(m=>{const ln=doc.lines[m.k];const v=num(ln.deposited)-num(ln.report);
    return `<tr><td>${m.l}</td>
      <td class="inp"><input id="${dept}-${m.k}-report" data-m="${m.k}" data-f="report" inputmode="decimal" autocomplete="off" autocorrect="off" spellcheck="false" data-lpignore="true" data-form-type="other" placeholder="0.00" value="${esc(ln.report)}" ${dis} aria-label="${m.l} per report"></td>
      <td class="inp"><input id="${dept}-${m.k}-deposited" data-m="${m.k}" data-f="deposited" inputmode="decimal" autocomplete="off" autocorrect="off" spellcheck="false" data-lpignore="true" data-form-type="other" placeholder="0.00" value="${esc(ln.deposited)}" ${dis} aria-label="${m.l} deposited"></td>
      <td class="num ${vcls(v)}" id="v-${m.k}">${RV(v)}</td></tr>`;}).join("");
  const di=dayInfo(state.date,current("wholesale"),current("retail"),current("manager"));
  main.innerHTML=`${!canEditDept(dept)?`<div class="notice">You are signed in as ${esc(ROLE_LABEL[role()])}, so the ${DEPTS[dept]} sheet is view-only for you.</div>`:""}${banner(di)}
  <div class="deptband ${dept}" role="heading" aria-level="2"><div><div class="big">${DEPTS[dept]} cash up</div><div class="small">${longDate(state.date)}</div></div><div class="small">You are filling in the <b>${DEPTS[dept]}</b> sheet</div></div>
  <section class="sheet ${dept}">
    <div class="sheet-head"><div><div class="eyebrow">${DEPTS[dept]} department</div><h2>${longDate(state.date)}</h2></div>${chip(statusOf(doc))}</div>
    <div class="sheet-body">
      <div class="fields">
        <div class="field"><label>Date</label><div class="static">${shortDate(state.date)}</div></div>
        <div class="field"><label>Person cashing up</label><div class="static">${esc(doc.cashier)||(editable?esc(state.me.name):"—")}</div></div>
        <div class="field"><label>Department</label><div class="static">${DEPTS[dept]}</div></div>
      </div>
      ${editable?`<div class="scan">
        <div style="min-width:0"><div class="eyebrow">Fill from photo</div><div class="msg">Take a photo of the last page of the cash up report. The report figures are filled in for you to check, and the photo is kept with this cash up.</div></div>
        <div class="actions">
          <label class="btn primary" for="${dept}-photo" style="display:inline-flex;align-items:center;gap:8px">Scan report photo</label>
          <label class="btn" for="${dept}-photo2" style="display:inline-flex;align-items:center;gap:8px">Add another photo</label>
        </div>
        <input type="file" id="${dept}-photo" accept="image/*" capture="environment" hidden>
        <input type="file" id="${dept}-photo2" accept="image/*" capture="environment" hidden>
        <div class="msg" id="scan-msg" style="flex-basis:100%"></div>
      </div>`:""}
      <div class="field"><label>Report photos</label><div data-photos="${dept}">${photoStrip(dept)}</div></div>
      <div class="tbl-wrap"><table>
        <thead><tr><th>Payment type</th><th>Per report<small>Till / Z-report</small></th><th>Deposited<small>Actual counted</small></th><th>Variance<small>Deposited − report</small></th></tr></thead>
        <tbody>${rows}</tbody>
        <tfoot><tr><td>Total</td><td class="num" id="t-report">${R(t.report)}</td><td class="num" id="t-dep">${R(t.deposited)}</td><td class="num ${vcls(t.variance)}" id="t-var">${RV(t.variance)}</td></tr></tfoot>
      </table></div>
      <div class="dmg">
        <div class="field"><label for="${dept}-damaged">Damaged bank notes &amp; coins (R)</label><input id="${dept}-damaged" class="num" inputmode="decimal" autocomplete="off" autocorrect="off" spellcheck="false" data-lpignore="true" data-form-type="other" placeholder="0.00" value="${esc(doc.damaged)}" ${dis} style="text-align:right"></div>
        <div class="field"><label for="${dept}-damagedNotes">Damaged details</label><input id="${dept}-damagedNotes" value="${esc(doc.damagedNotes)}" placeholder="e.g. 1 × R100 torn, 3 × R5 coins bent" autocomplete="off" ${dis} maxlength="300"></div>
      </div>
      <div class="field"><label for="${dept}-notes">Notes (explain any variance)</label><textarea id="${dept}-notes" ${dis} maxlength="1000" placeholder="e.g. R50 short on cash, float counted twice">${esc(doc.notes)}</textarea></div>
      <div class="saved" id="saved-${dept}">${doc.updatedAt?"Last saved "+timeStr(doc.updatedAt):(editable?"Saves automatically as you type":"")}</div>
    </div>
  </section>
  <section class="sheet">
    <div class="sheet-head"><div><div class="eyebrow">Sign-off</div><h2>${DEPTS[dept]} signature</h2></div></div>
    <div class="sheet-body">${signed?signedBlock(doc,dept):canSignDept(dept)?signBlock(doc,dept):`<div class="msg">Only the ${DEPTS[dept]} cashier can sign this sheet.</div>`}</div>
  </section>`;
  bindDept(dept);
}
function signedBlock(doc,dept){const img=safeImg(doc.signature);return `<div class="sign">
  <div class="sig-img">${img?`<img src="${img}" alt="Signature of ${esc(doc.signedBy)}">`:""}</div>
  <div style="display:flex;flex-direction:column;gap:10px">
    <div><div class="eyebrow">Signed by</div><div class="signer-static">${esc(doc.signedBy)}</div><div class="msg">${timeStr(doc.signedAt)}</div></div>
    <div class="msg">This ${dept==="manager"?"day":"cash up"} is locked.${canReopen(dept)?" Reopen it only to correct a mistake; the signature is removed, the reopen is recorded, and it must be signed again.":" The manager has closed the day, so only the manager can reopen it from End of Day."}</div>
    ${canReopen(dept)?`<div class="actions"><button class="btn danger" id="reopen">Reopen to correct</button><span class="msg" id="reopen-msg"></span></div>`:""}
  </div></div>`;}
function signBlock(doc,dept){return `<div class="sign">
  <div class="pad"><canvas id="pad" width="900" height="300" aria-label="Signature pad"></canvas><div class="base"></div><div class="hint">Sign above the line with finger or mouse</div></div>
  <div style="display:flex;flex-direction:column;gap:10px">
    <div class="msg">${dept==="manager"?`By signing, I confirm I have checked the Wholesale and Retail cash ups for ${shortDate(state.date)} and the combined totals are correct.`:`By signing, I confirm the amounts deposited for ${DEPTS[dept]} on ${shortDate(state.date)} are correct.`}</div>
    <div><div class="eyebrow">Signing as</div><div class="signer-static">${esc(state.me.name)}</div></div>
    <div class="actions"><button class="btn" id="clear" type="button">Clear</button><button class="btn primary" id="signbtn" type="button">Sign &amp; submit</button></div>
    <div class="msg" id="sign-msg"></div>
  </div></div>`;}

function patchInputs(dept){const doc=local[dept];
  METHODS.forEach(m=>["report","deposited"].forEach(f=>{const el=document.getElementById(dept+"-"+m.k+"-"+f);if(el&&el!==document.activeElement)el.value=doc.lines[m.k][f];}));
  [["notes","notes"],["damaged","damaged"],["damagedNotes","damagedNotes"]].forEach(([id,k])=>{const el=document.getElementById(dept+"-"+id);if(el&&el!==document.activeElement)el.value=doc[k];});
  recalc(dept);}
function recalc(dept){const doc=local[dept];
  METHODS.forEach(m=>{const v=num(doc.lines[m.k].deposited)-num(doc.lines[m.k].report);const el=document.getElementById("v-"+m.k);if(el){el.textContent=RV(v);el.className="num "+vcls(v);}});
  const t=totals(doc),a=$("#t-report"),b=$("#t-dep"),c=$("#t-var");
  if(a){a.textContent=R(t.report);b.textContent=R(t.deposited);c.textContent=RV(t.variance);c.className="num "+vcls(t.variance);}}
// Amounts: accept a comma or a point as the decimal mark, keep at most 2 decimals
const money=v=>{let t=String(v).replace(/,/g,".").replace(/[^0-9.]/g,"");
  const i=t.indexOf(".");if(i>=0)t=t.slice(0,i+1)+t.slice(i+1).replace(/\./g,"").slice(0,2);
  return t.slice(0,12);};

function bindDept(dept){const doc=local[dept];
  main.querySelectorAll("td.inp input").forEach(inp=>{
    // clicking into a box selects the amount, so typing simply replaces it
    inp.addEventListener("focus",()=>{try{inp.select();}catch(e){}});
    inp.addEventListener("mouseup",e=>{if(inp.dataset.sel!=="1"){e.preventDefault();inp.dataset.sel="1";}});
    inp.addEventListener("blur",()=>{inp.dataset.sel="";});
    // leave what the person types alone (comma or point); only strip letters. Tidy to 2 decimals on leaving the box.
    inp.addEventListener("input",()=>{if(/[^0-9.,]/.test(inp.value))inp.value=inp.value.replace(/[^0-9.,]/g,"");doc.lines[inp.dataset.m][inp.dataset.f]=money(inp.value);recalc(dept);scheduleSave(dept);});
    inp.addEventListener("blur",()=>{if(inp.value!==""){const v=num(money(inp.value)).toFixed(2);inp.value=v;doc.lines[inp.dataset.m][inp.dataset.f]=v;scheduleSave(dept);}});});
  const n=document.getElementById(dept+"-notes");if(n)n.addEventListener("input",()=>{doc.notes=n.value;scheduleSave(dept);});
  const dm=document.getElementById(dept+"-damaged");if(dm){dm.addEventListener("focus",()=>{try{dm.select();}catch(e){}});dm.addEventListener("mouseup",e=>{if(dm.dataset.sel!=="1"){e.preventDefault();dm.dataset.sel="1";}});dm.addEventListener("blur",()=>{dm.dataset.sel="";});dm.addEventListener("input",()=>{if(/[^0-9.,]/.test(dm.value))dm.value=dm.value.replace(/[^0-9.,]/g,"");doc.damaged=money(dm.value);scheduleSave(dept);});
    dm.addEventListener("blur",()=>{if(dm.value!==""){dm.value=num(money(dm.value)).toFixed(2);doc.damaged=dm.value;scheduleSave(dept);}});}
  const dn=document.getElementById(dept+"-damagedNotes");if(dn)dn.addEventListener("input",()=>{doc.damagedNotes=dn.value;scheduleSave(dept);});
  const ro=$("#reopen");if(ro){let armed=false;ro.addEventListener("click",async()=>{
    if(!armed){armed=true;ro.textContent="Tap again to reopen";$("#reopen-msg").textContent="The signature will be removed.";setTimeout(()=>{armed=false;if(ro.isConnected){ro.textContent="Reopen to correct";$("#reopen-msg").textContent="";}},4000);return;}
    ro.disabled=true;
    const M=current("manager");
    if(dept!=="manager"&&M.status==="signed"){
      if(!["manager","admin"].includes(role())){ro.disabled=false;$("#reopen-msg").textContent="The day is closed. Ask the manager to reopen it.";return;}
      Object.assign(M,{status:"draft",signature:"",signedBy:"",signedAt:""});state.pending.manager=true;
      if(!await save("manager",{action:"reopened",by:state.me.name})){ro.disabled=false;$("#reopen-msg").textContent="Could not reopen the day. Try again.";return;}}
    Object.assign(doc,{status:"draft",signature:"",signedBy:"",signedAt:""});clearTimeout(timers[dept]);state.pending[dept]=true;
    await save(dept,{action:"reopened",by:state.me.name});render(true);});}
  const pad=$("#pad");if(pad)bindPad(pad,dept);
  const ph=document.getElementById(dept+"-photo");if(ph)ph.addEventListener("change",()=>{const f=ph.files&&ph.files[0];ph.value="";if(f)scanPhoto(f,dept,true);});
  const ph2=document.getElementById(dept+"-photo2");if(ph2)ph2.addEventListener("change",()=>{const f=ph2.files&&ph2.files[0];ph2.value="";if(f)scanPhoto(f,dept,false);});
  document.querySelectorAll("[data-photos]").forEach(bindThumbs);
}
function bindPad(cv,dept){const ctx=cv.getContext("2d");let drawing=false,inked=false,last=null;
  ctx.lineWidth=3.2;ctx.lineCap="round";ctx.lineJoin="round";ctx.strokeStyle="#1f2a44";ctx.fillStyle="#1f2a44";
  const pt=e=>{const r=cv.getBoundingClientRect();return {x:(e.clientX-r.left)*cv.width/r.width,y:(e.clientY-r.top)*cv.height/r.height};};
  cv.addEventListener("pointerdown",e=>{cv.dataset.inked="1";drawing=true;last=pt(e);cv.setPointerCapture(e.pointerId);ctx.beginPath();ctx.arc(last.x,last.y,1.5,0,Math.PI*2);ctx.fill();inked=true;});
  cv.addEventListener("pointermove",e=>{if(!drawing)return;const p=pt(e);ctx.beginPath();ctx.moveTo(last.x,last.y);ctx.lineTo(p.x,p.y);ctx.stroke();last=p;});
  const end=()=>{drawing=false;};cv.addEventListener("pointerup",end);cv.addEventListener("pointercancel",end);
  $("#clear").addEventListener("click",()=>{ctx.clearRect(0,0,cv.width,cv.height);inked=false;delete cv.dataset.inked;$("#sign-msg").textContent="";if(state.deferred)render(true);});
  $("#signbtn").addEventListener("click",async()=>{const doc=local[dept];const msg=$("#sign-msg");msg.className="msg err";
    if(dept==="manager"){const W=current("wholesale"),Rt=current("retail");
      if(!(W.status==="signed"&&Rt.status==="signed")){msg.textContent="Wholesale and Retail must both sign first.";return;}
      const nm=state.me.name.trim().toLowerCase();
      if(nm&&(nm===String(W.signedBy).trim().toLowerCase()||nm===String(Rt.signedBy).trim().toLowerCase())){msg.textContent="The manager sign-off must be done by a different person from the cashiers who signed.";return;}}
    else{const t=totals(doc);if(t.report===0&&t.deposited===0){msg.textContent="Enter the report and deposited amounts before signing.";return;}}
    const who=state.me.name;
    if(!inked){msg.textContent="Draw the signature in the box first.";return;}
    const out=document.createElement("canvas");out.width=600;out.height=200;const o=out.getContext("2d");o.fillStyle="#fff";o.fillRect(0,0,600,200);o.drawImage(cv,0,0,600,200);
    const before=clone(doc);
    Object.assign(doc,{signature:out.toDataURL("image/png"),signedBy:who,signedAt:new Date().toISOString(),status:"signed"});
    if(dept!=="manager"&&!doc.cashier)doc.cashier=who;
    clearTimeout(timers[dept]);state.pending[dept]=true;$("#signbtn").disabled=true;msg.className="msg";msg.textContent="Signing…";
    const ok=await save(dept,{signing:true,action:"signed",by:who});
    if(!ok){local[dept]=before;render(true);const m2=$("#sign-msg");if(m2){m2.className="msg err";m2.textContent="Not signed. Check the connection and try again.";}return;}
    render(true);});
}

function renderCombined(){
  const W=current("wholesale"),Rt=current("retail"),M=current("manager");const tw=totals(W),tr=totals(Rt);
  const both=W.status==="signed"&&Rt.status==="signed";const info=dayInfo(state.date,W,Rt,M);
  const dmgT=num(W.damaged)+num(Rt.damaged);
  const mgrBlock=M.status==="signed"?signedBlock(M,"manager"):!canSignManager()?`<div class="msg">Only a manager can sign off the day. ${both?"Waiting for the manager.":"Wholesale and Retail must sign first."}</div>`:both?signBlock(M,"manager"):`<div class="msg">You can sign here once Wholesale and Retail have both signed. Still waiting for: ${[W.status!=="signed"?"Wholesale":"",Rt.status!=="signed"?"Retail":""].filter(Boolean).join(" and ")}.</div>`;
  const rows=METHODS.map(m=>{const wr=num(W.lines[m.k].report),wd=num(W.lines[m.k].deposited),rr=num(Rt.lines[m.k].report),rd=num(Rt.lines[m.k].deposited);const v=(wd+rd)-(wr+rr);
    return `<tr><td>${m.l}</td><td class="num grp">${R(wr)}</td><td class="num">${R(wd)}</td><td class="num grp">${R(rr)}</td><td class="num">${R(rd)}</td><td class="num grp"><b>${R(wr+rr)}</b></td><td class="num"><b>${R(wd+rd)}</b></td><td class="num ${vcls(v)}">${RV(v)}</td></tr>`;}).join("");
  const gv=(tw.deposited+tr.deposited)-(tw.report+tr.report);
  const sig=(doc,dept)=>{const img=safeImg(doc.signature);return `<div class="sigbox"><div class="eyebrow">${DEPTS[dept]}</div>${doc.status==="signed"?`<div class="sig-img">${img?`<img src="${img}" alt="${DEPTS[dept]} signature">`:""}</div><div class="who">${esc(doc.signedBy)} · ${timeStr(doc.signedAt)}</div>`:`<div class="empty">Awaiting signature</div><div class="who">${doc.cashier?esc(doc.cashier)+" · ":""}${statusOf(doc)==="draft"?"in progress":"not started"}</div>`}</div>`;};
  const stat=(d,l)=>chip(statusOf(d)).replace("Signed off",l+" signed").replace("In progress",l+" in progress").replace("Not started",l+" not started");
  main.innerHTML=`
  <div class="banner ${info.kind==="done"?"ok":info.kind==="overdue"?"bad":"wait"}">${info.kind==="done"?"Day closed on time. Wholesale, Retail and Manager have all signed.":info.kind==="late"?"Day closed, but after the 7 pm deadline. "+info.label+".":info.kind==="overdue"?"Past the 7 pm deadline. Missing signature: "+info.missing.join(", ")+". Ulla is notified by email.":info.kind==="sunday"?"Sunday is not a trading day.":"Day still open. "+info.label+". Still to sign: "+info.missing.join(", ")+"."}</div>
  <div class="summary">
    <div class="stat"><div class="k">Per reports</div><div class="v num">${R(tw.report+tr.report)}</div></div>
    <div class="stat"><div class="k">Deposited</div><div class="v num">${R(tw.deposited+tr.deposited)}</div></div>
    <div class="stat"><div class="k">Variance</div><div class="v num ${vcls(gv)}">${RV(gv)}</div></div>
    <div class="stat"><div class="k">Cash + CashGuard banked</div><div class="v num">${R(["cash","cashguard"].reduce((s,k)=>s+num(W.lines[k].deposited)+num(Rt.lines[k].deposited),0))}</div></div>
  </div>
  <section class="sheet">
    <div class="sheet-head"><div><div class="eyebrow">Combined end-of-day cash up</div><h2>${longDate(state.date)}</h2></div><div class="actions">${stat(W,"Wholesale")}${stat(Rt,"Retail")}</div></div>
    <div class="sheet-body">
      <div class="tbl-wrap"><table style="min-width:820px">
        <thead><tr><th rowspan="2">Payment type</th><th colspan="2" class="grp" style="text-align:center">Wholesale</th><th colspan="2" class="grp" style="text-align:center">Retail</th><th colspan="3" class="grp" style="text-align:center">Combined</th></tr>
        <tr><th class="grp">Report</th><th>Deposited</th><th class="grp">Report</th><th>Deposited</th><th class="grp">Report</th><th>Deposited</th><th>Variance</th></tr></thead>
        <tbody>${rows}</tbody>
        <tfoot><tr><td>Total</td><td class="num grp">${R(tw.report)}</td><td class="num">${R(tw.deposited)}</td><td class="num grp">${R(tr.report)}</td><td class="num">${R(tr.deposited)}</td><td class="num grp">${R(tw.report+tr.report)}</td><td class="num">${R(tw.deposited+tr.deposited)}</td><td class="num ${vcls(gv)}">${RV(gv)}</td></tr></tfoot>
      </table></div>
      <div class="fields" style="grid-template-columns:repeat(2,minmax(0,1fr))">
        <div class="field"><label>Wholesale cashed up by</label><div class="static">${esc(W.cashier)||"—"}</div></div>
        <div class="field"><label>Retail cashed up by</label><div class="static">${esc(Rt.cashier)||"—"}</div></div>
      </div>
      ${(W.notes||Rt.notes)?`<div class="field"><label>Notes</label><div class="static" style="font-weight:400;white-space:pre-wrap">${W.notes?"<b>Wholesale:</b> "+esc(W.notes):""}${W.notes&&Rt.notes?"\n":""}${Rt.notes?"<b>Retail:</b> "+esc(Rt.notes):""}</div></div>`:""}
      <div class="field"><label>Damaged bank notes &amp; coins</label><div class="static num" style="font-weight:400">Wholesale ${R(num(W.damaged))}${W.damagedNotes?" ("+esc(W.damagedNotes)+")":""} · Retail ${R(num(Rt.damaged))}${Rt.damagedNotes?" ("+esc(Rt.damagedNotes)+")":""} · <b>Total ${R(dmgT)}</b></div></div>
      <div class="fields" style="grid-template-columns:repeat(2,minmax(0,1fr))">
        <div class="field"><label>Wholesale report photos</label><div data-photos="wholesale">${photoStrip("wholesale")}</div></div>
        <div class="field"><label>Retail report photos</label><div data-photos="retail">${photoStrip("retail")}</div></div>
      </div>
      <div class="sigs">${sig(W,"wholesale")}${sig(Rt,"retail")}</div>
      <div class="actions"><button class="btn primary" id="pdf-mail" type="button">Email PDF report</button><button class="btn" id="pdf-dl" type="button">Download PDF</button><button class="btn" id="csv">Download day as CSV</button><span class="msg" id="csv-msg"></span></div>
    </div>
  </section>
  <section class="sheet">
    <div class="sheet-head"><div><div class="eyebrow">End-of-day sign-off · due by 7 pm</div><h2>Manager signature</h2></div>${M.status==="signed"?'<span class="chip signed">Signed off</span>':'<span class="chip">Not signed</span>'}</div>
    <div class="sheet-body">${mgrBlock}</div>
  </section>`;
  local.manager=M;bindDept("manager");
  $("#pdf-dl").addEventListener("click",()=>pdfAction("download"));
  $("#pdf-mail").addEventListener("click",()=>pdfAction("email"));
  $("#csv").addEventListener("click",()=>{
    const f=x=>typeof x==="number"?x.toFixed(2):x;
    const lines=[["Date",state.date],[],["Payment type","Wholesale report","Wholesale deposited","Retail report","Retail deposited","Combined report","Combined deposited","Variance"]];
    METHODS.forEach(m=>{const wr=num(W.lines[m.k].report),wd=num(W.lines[m.k].deposited),rr=num(Rt.lines[m.k].report),rd=num(Rt.lines[m.k].deposited);lines.push([m.l,wr,wd,rr,rd,wr+rr,wd+rd,(wd+rd)-(wr+rr)].map(f));});
    lines.push(["Total",tw.report,tw.deposited,tr.report,tr.deposited,tw.report+tr.report,tw.deposited+tr.deposited,gv].map(f));
    lines.push([],["Wholesale cashed up by",W.cashier,"Signed by",W.signedBy,W.signedAt],["Retail cashed up by",Rt.cashier,"Signed by",Rt.signedBy,Rt.signedAt],["Wholesale notes",W.notes],["Retail notes",Rt.notes],
      ["Damaged notes & coins - Wholesale",num(W.damaged).toFixed(2),W.damagedNotes],["Damaged notes & coins - Retail",num(Rt.damaged).toFixed(2),Rt.damagedNotes],["Manager signed by",M.signedBy,M.signedAt],["Day status",info.label]);
    // Prefix cells that start with = + - @ so spreadsheets do not run them as formulas
    const cell=c=>{c=String(c==null?"":c);if(/^[=+\-@]/.test(c)&&!/^-?\d+(\.\d+)?$/.test(c))c="'"+c;return /[",\n]/.test(c)?'"'+c.replace(/"/g,'""')+'"':c;};
    const csv=lines.map(r=>r.map(cell).join(",")).join("\n");
    const a=document.createElement("a");a.href=URL.createObjectURL(new Blob([csv],{type:"text/csv"}));a.download="cash-up-"+state.date+".csv";document.body.appendChild(a);a.click();a.remove();
    $("#csv-msg").textContent="Downloaded.";});
}

const safeJpg=s=>/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(String(s||""))?s:"";
function canRemovePhoto(dept){return state.tab===dept&&canEditDept(dept)&&current(dept).status!=="signed";}
/* ---------- PDF report ---------- */
const REPORT_TO="martie@tastytreats.co.za";
let jsPDFlib=null;
function loadJsPDF(){if(jsPDFlib)return Promise.resolve(jsPDFlib);
  return new Promise((res,rej)=>{const sc=document.createElement("script");sc.src="https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js";
    sc.onload=()=>{jsPDFlib=window.jspdf&&window.jspdf.jsPDF;jsPDFlib?res(jsPDFlib):rej(new Error("PDF tool did not load"));};sc.onerror=()=>rej(new Error("PDF tool could not be downloaded"));document.head.appendChild(sc);});}
async function makePdf(){const [{buildReportPdf,reportFileName},jsPDF]=await Promise.all([import("./report-pdf.js?v=2026-10-13e"),loadJsPDF()]);
  const W=current("wholesale"),Rt=current("retail"),M=current("manager");const info=dayInfo(state.date,W,Rt,M);
  const photos=state.photos.filter(p=>p.removed!==true&&safeJpg(p.data)).sort((a,b)=>a.dept.localeCompare(b.dept)||String(a.takenAt||"").localeCompare(String(b.takenAt||"")));
  const pdf=buildReportPdf(jsPDF,{date:state.date,niceDate:longDate(state.date),W,Rt,M,status:info.label,photos});
  return {blob:pdf.output("blob"),name:reportFileName(state.date),info};}
async function pdfAction(kind){const msg=$("#csv-msg");const say=(t,err)=>{if(msg){msg.className="msg"+(err?" err":"");msg.textContent=t;}};
  say("Preparing the PDF…");let r;
  try{r=await makePdf();}catch(e){console.error("PDF:",e);say("The PDF could not be made: "+(e&&e.message||e),true);return;}
  const download=()=>{const a=document.createElement("a");a.href=URL.createObjectURL(r.blob);a.download=r.name;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(a.href),60000);};
  if(kind==="download"){download();say("PDF downloaded.");return;}
  const subject="Factory Shop Cash Up – "+shortDate(state.date);
  const body="Hi Martie,\n\nPlease find attached the factory shop cash up report for "+longDate(state.date)+".\nStatus: "+r.info.label+"\n\nKind regards,\n"+(state.me?state.me.name:"");
  // phones and tablets: share the PDF straight into Gmail, Outlook, WhatsApp…
  try{const file=new File([r.blob],r.name,{type:"application/pdf"});
    if(navigator.canShare&&navigator.canShare({files:[file]})){await navigator.share({files:[file],title:subject,text:body});say("Shared. Choose your email app and send it to "+REPORT_TO+" if it was not filled in.");return;}}
  catch(e){if(e&&e.name==="AbortError"){say("Not sent.");return;}}
  // computers: download the PDF and open a ready-made email; the PDF must be attached by hand
  download();
  location.href="mailto:"+REPORT_TO+"?subject="+encodeURIComponent(subject)+"&body="+encodeURIComponent(body+"\n\n(PDF attached)");
  say("The PDF was downloaded and a new email opened. Attach the file "+r.name+" (in your Downloads) and press Send.");}

// Removing a photo also clears the "Per report" figures that were read from it.
function clearPhotoFigures(ph){const dept=ph.dept;if(!DEPTS[dept]||dept==="manager")return;
  const doc=current(dept);if(!doc||doc.status==="signed")return;
  const rec=doc.aiFill&&doc.aiFill[ph.id];let keys=[];
  if(rec)keys=Object.keys(rec);
  else if(!state.photos.some(x=>x.dept===dept&&x.id!==ph.id&&x.removed!==true))keys=METHODS.map(m=>m.k); // older photo, nothing recorded: clear the report column when no photo is left
  keys.forEach(k=>{if(!doc.lines[k])return;doc.lines[k].report="";
    const el=document.getElementById(dept+"-"+k+"-report");if(el){el.value="";el.style.background="";}});
  if(doc.aiFill){delete doc.aiFill[ph.id];}
  if(state.tab===dept)recalc(dept);
  if(keys.length||rec)scheduleSave(dept);
  const m=$("#scan-msg");if(m&&keys.length){m.className="msg";m.textContent="Photo removed. The report figures read from it were cleared.";}}
function photoStrip(dept){const all=state.photos.filter(p=>p.dept===dept);const ps=all.filter(p=>p.removed!==true);const gone=all.filter(p=>p.removed===true);
  const rm=canRemovePhoto(dept);
  const goneNote=gone.length?`<div class="msg" style="margin-top:6px">${gone.map(p=>`Photo removed by ${esc(p.removedBy)}${p.removedAtIso?" · "+esc(timeStr(p.removedAtIso)):""}`).join("<br>")}</div>`:"";
  if(!ps.length)return '<div class="msg">No photo yet.</div>'+goneNote;
  return `<div class="actions" style="align-items:flex-start">${ps.map(p=>{const src=safeJpg(p.data);return src?`<div style="display:flex;flex-direction:column;gap:4px;align-items:center"><button class="thumb" type="button" data-pid="${esc(p.id)}" title="${esc(p.by)} · ${esc(timeStr(p.takenAt))}" style="padding:0;border:1px solid var(--line);border-radius:8px;overflow:hidden;background:#fff;cursor:zoom-in"><img src="${src}" alt="Report photo taken by ${esc(p.by)}" style="display:block;height:72px;width:auto"></button>${rm?`<button class="linkbtn" type="button" data-read="${esc(p.id)}" style="font-size:.78rem">Read figures</button><button class="linkbtn" type="button" data-rm="${esc(p.id)}" style="color:var(--bad);font-size:.78rem">Remove</button>`:""}</div>`:"";}).join("")}</div>`+goneNote;}
function bindThumbs(el){
  el.querySelectorAll("button[data-read]").forEach(b=>b.addEventListener("click",()=>{const p=state.photos.find(x=>x.id===b.dataset.read);if(p&&safeJpg(p.data))readFigures(p.data,p.dept,"",p.id);}));
  el.querySelectorAll("button[data-rm]").forEach(b=>{let armed=false;b.addEventListener("click",async()=>{
    if(!armed){armed=true;b.textContent="Tap again: removes photo and its figures";setTimeout(()=>{armed=false;if(b.isConnected)b.textContent="Remove";},4000);return;}
    b.disabled=true;
    const pid=b.dataset.rm,ph=state.photos.find(x=>x.id===pid);
    try{await updateDoc(fdoc(photosCol(),pid),{removed:true,removedBy:state.me.name,removedAt:serverTimestamp(),removedAtIso:new Date().toISOString()});}
    catch(e){b.disabled=false;b.textContent="Could not remove";return;}
    if(ph)clearPhotoFigures(ph);});});
  el.querySelectorAll("button[data-pid]").forEach(b=>b.addEventListener("click",()=>{const p=state.photos.find(x=>x.id===b.dataset.pid);if(!p)return;
  const ov=document.createElement("div");ov.style.cssText="position:fixed;inset:0;background:rgba(0,0,0,.85);z-index:50;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:16px;gap:10px;cursor:zoom-out";
  ov.innerHTML=`<img src="${safeJpg(p.data)}" alt="Report photo" style="max-width:100%;max-height:85vh;border-radius:8px;background:#fff"><div style="color:#fff;font-size:.85rem">${esc(DEPTS[p.dept]||"")} · ${esc(p.by)} · ${esc(timeStr(p.takenAt))} · tap to close</div>`;
  ov.addEventListener("click",()=>ov.remove());document.body.appendChild(ov);}));}
function toJpeg(file,maxSide,quality){return new Promise((res,rej)=>{const img=new Image();const u=URL.createObjectURL(file);
  img.onload=()=>{const k=Math.min(1,maxSide/Math.max(img.width,img.height));const c=document.createElement("canvas");c.width=Math.round(img.width*k);c.height=Math.round(img.height*k);
    const x=c.getContext("2d");x.fillStyle="#fff";x.fillRect(0,0,c.width,c.height);x.drawImage(img,0,0,c.width,c.height);URL.revokeObjectURL(u);res(c.toDataURL("image/jpeg",quality));};
  img.onerror=()=>{URL.revokeObjectURL(u);rej(new Error("image"));};img.src=u;});}
// Model names change over time: try the configured one first, then current fallbacks, and remember what worked.
const AI_MODELS=[...new Set([AI_MODEL,"gemini-3.5-flash","gemini-3.1-flash-lite","gemini-3.5-flash-lite","gemini-flash-latest","gemini-2.5-flash","gemini-2.0-flash"].filter(Boolean))];
// Two routes to Gemini: "Agent Platform" (Vertex AI, Blaze plan, no extra key) first, then the Gemini Developer API.
const AI_ROUTES=[["vertex-global",m=>new m.VertexAIBackend("global")],["vertex-us",m=>new m.VertexAIBackend("us-central1")],["google",m=>new m.GoogleAIBackend()]];
let aiMod=null;const aiInst={};
async function readWithAI(parts){
  if(!aiMod)aiMod=await import("https://www.gstatic.com/firebasejs/12.17.1/firebase-ai.js");
  let good=null;try{good=JSON.parse(localStorage.getItem("cu_airoute")||"null");}catch(e){}
  const combos=[];if(good&&good.r&&good.m)combos.push([good.r,good.m]);
  for(const [r] of AI_ROUTES)for(const m of AI_MODELS)if(!(good&&good.r===r&&good.m===m))combos.push([r,m]);
  let last=null,lastUseful=null;const deadRoutes=new Set();
  for(const [route,name] of combos){
    if(deadRoutes.has(route))continue;
    try{if(!aiInst[route])aiInst[route]=aiMod.getAI(app,{backend:AI_ROUTES.find(x=>x[0]===route)[1](aiMod)});
      const model=aiMod.getGenerativeModel(aiInst[route],{model:name,generationConfig:{responseMimeType:"application/json",temperature:0}});
      const r=await model.generateContent(parts);try{localStorage.setItem("cu_airoute",JSON.stringify({r:route,m:name}));}catch(e){}return r;}
    catch(e){last=e;const t=String(e&&(e.message||e.code)||"");
      if(/Failed to fetch|NetworkError|network/i.test(t))throw e;                       // no connection: stop
      if(/quota|429|RESOURCE_EXHAUSTED/i.test(t)){lastUseful=e;deadRoutes.add(route);continue;}
      if(/not.?found|404|not supported|is not available|unsupported model|invalid model/i.test(t)&&!/genai|config/i.test(t))continue; // model unknown: try next model
      // route not set up / not allowed: try the next route
      lastUseful=lastUseful||e;deadRoutes.add(route);}
  }
  throw lastUseful||last||new Error("No AI model available");}
async function scanPhoto(file,dept,read){const msg=$("#scan-msg");const say=(t,err)=>{const m=$("#scan-msg");if(m){m.className="msg"+(err?" err":"");m.textContent=t;}};
  say("Saving the photo and reading the report…");
  let keep,forAi;
  try{forAi=await toJpeg(file,1800,0.85);keep=await toJpeg(file,1400,0.6);if(keep.length>850000)keep=await toJpeg(file,1100,0.5);if(keep.length>850000)keep=await toJpeg(file,900,0.45);}
  catch(e){say("That file could not be opened as a photo. Try again.",true);return;}
  // 1. keep a copy of the photo with this cash up
  let saved=false;
  const ref=fdoc(photosCol());
  try{await setDoc(ref,{date:state.date,dept,data:keep,by:state.me.name,at:serverTimestamp(),takenAt:new Date().toISOString()});saved=true;}
  catch(e){say("The photo could not be saved. Check the connection and try again.",true);return;}
  if(!read){say("Photo added. The figures were not changed.");return;}
  await readFigures(forAi,dept,"Photo saved. ",ref.id);
}
async function readFigures(dataUrl,dept,lead,photoId){lead=lead||"";state.lastAI="";
  const say=(t,err)=>{const m=$("#scan-msg");if(!m)return;m.className="msg"+(err?" err":"");m.textContent=t;
    if(state.lastAI){const d=document.createElement("details");d.style.marginTop="6px";d.innerHTML='<summary style="cursor:pointer">Show what the reader saw</summary><pre style="white-space:pre-wrap;font-size:.78rem;max-height:240px;overflow:auto;background:var(--bg);padding:8px;border-radius:8px"></pre>';d.querySelector("pre").textContent=String(state.lastAI).slice(0,3000);m.appendChild(d);}};
  say(lead+"Reading the report figures…");
  const prompt=`This is a photo of the last page of a South African retail till cash-up / Z-report (amounts in Rand) for the ${DEPTS[dept]} department of a factory shop.
Read the TOTAL amount per payment/tender type as printed on the report. Map tenders to these keys:
- cash: Cash (notes and coins tender)
- cashguard: CashGuard (cash recycler / CashGuard tender)
- card: Credit card / debit card / speedpoint / card machine totals combined
- eft: EFT / bank transfer
- shop2shop: Shop2Shop
- snapscan: SnapScan
Return ONLY JSON: {"cash":number|null,"cashguard":number|null,"card":number|null,"eft":number|null,"shop2shop":number|null,"snapscan":number|null,"total":number|null,"date":"YYYY-MM-DD"|null,"readable":true|false}
Use null when a tender is not on the report. Give amounts as plain JSON numbers with a dot for decimals (e.g. 1234.56), without currency symbols, spaces or thousands separators, even if the slip prints them as "R 1 234,56". Set readable false if the photo is not a cash-up report or too blurry to read.`;
  let out=null;
  try{const r=await readWithAI([prompt,{inlineData:{data:dataUrl.split(",")[1],mimeType:"image/jpeg"}}]);
    state.lastAI=r.response.text();let t=r.response.text().trim().replace(/^\`\`\`(json)?/i,"").replace(/\`\`\`$/,"");out=JSON.parse(t);}
  catch(e){const raw=String(e&&(e.message||e.code)||e||"");
    const why=/App Check/i.test(raw)?"Google's App Check protection is not set up for this app yet."
      :/genai|config not found/i.test(raw)?"Firebase AI Logic is not fully set up for this project (Gemini Developer API link missing)."
      :/not.?enabled|has not been used|SERVICE_DISABLED|enable the/i.test(raw)?"The AI reader is not switched on in Firebase yet."
      :/not found|404|is not supported|model/i.test(raw)?"None of the AI models were accepted by your project. Check that AI Logic is set up with the Gemini Developer API."
      :/quota|429|RESOURCE_EXHAUSTED/i.test(raw)?"The free AI allowance for today is used up."
      :/API key|referer|referrer|blocked/i.test(raw)?"The Firebase web key is not allowed to use the AI reader."
      :/Failed to fetch|network|import/i.test(raw)?"The AI reader could not be reached (connection)."
      :"The AI reader refused the request.";
    state.lastAI="ERROR: "+raw;say(lead+"The figures could not be read automatically. "+why+" Type the report figures by hand. Details: "+raw.slice(0,220),true);console.error("AI reader:",e);return;}
  if(!out||out.readable===false){say(lead+"The photo was not readable. Retake it flat, in good light, with the whole page in view, or type the figures by hand.",true);return;}
  const doc=local[dept];const filled=[];
  // accept numbers or text like "R 1 234,56" / "1,234.56", and keys in any case
  const toNum=v=>{if(typeof v==="number")return isFinite(v)?v:null;if(typeof v!=="string")return null;
    let t=v.replace(/[R\s\u00a0]/gi,"");if(!t)return null;
    if(t.includes(",")&&!t.includes("."))t=t.replace(/,(?=\d{1,2}$)/,".").replace(/,/g,"");else t=t.replace(/,/g,"");
    const n=parseFloat(t);return isFinite(n)?n:null;};
  const low={};Object.keys(out||{}).forEach(k=>low[k.toLowerCase().replace(/[^a-z0-9]/g,"")]=out[k]);
  const alias={cash:["cash"],cashguard:["cashguard"],card:["card","creditcard","cards"],eft:["eft"],shop2shop:["shop2shop","shoptoshop"],snapscan:["snapscan"]};
  out.total=toNum(low.total);
  METHODS.forEach(m=>{let v=null;for(const k of alias[m.k]){if(low[k]!=null){v=toNum(low[k]);break;}}if(v!=null){doc.lines[m.k].report=v.toFixed(2);filled.push(m.l);
    const el=document.getElementById(dept+"-"+m.k+"-report");if(el){el.value=v.toFixed(2);el.style.background="var(--accent-soft)";}}});
  // remember which figures came from which photo, so removing the photo removes them too
  if(photoId&&filled.length){doc.aiFill=doc.aiFill||{};const f={};METHODS.forEach(m=>{if(filled.includes(m.l))f[m.k]=doc.lines[m.k].report;});doc.aiFill[photoId]=f;}
  recalc(dept);if(filled.length)scheduleSave(dept);
  const t=totals(doc);let extra="";
  if(typeof out.total==="number"&&Math.abs(out.total-t.report)>0.009)extra+=` The report total reads ${R(out.total)} but the lines add to ${R(t.report)}; check for a missed payment type.`;
  if(out.date&&out.date!==state.date)extra+=` The report appears to be dated ${shortDate(out.date)}, not ${shortDate(state.date)}.`;
  say(filled.length?`${lead}Filled ${filled.join(", ")} from the report. Check each figure against the slip before signing.${extra}`:lead+"No payment totals were found on the photo. Type the figures by hand.",!!extra||!filled.length);
}
function renderUsers(){
  const rows=state.users.map(u=>`<div class="hrow" style="cursor:default;grid-template-columns:minmax(0,1fr) minmax(0,1fr) auto">
      <div><div class="d">${esc(u.name)}</div><div class="msg">${esc(ROLE_LABEL[u.role]||u.role)}</div></div>
      <div>${u.active===true?'<span class="chip signed">Active</span>':'<span class="chip">Switched off</span>'}</div>
      <div class="actions">${u.id===state.me.id?'<span class="msg">You</span>':`<button class="btn" data-act="toggle" data-u="${esc(u.id)}" type="button">${u.active===true?"Switch off":"Switch on"}</button>`}<button class="btn" data-act="pin" data-u="${esc(u.id)}" type="button">New PIN</button>${u.id===state.me.id?"":`<button class="btn" data-act="del" data-u="${esc(u.id)}" type="button" style="color:var(--bad)">Delete</button>`}</div></div>`).join("");
  main.innerHTML=`<section class="sheet">
    <div class="sheet-head"><div><div class="eyebrow">Administrator</div><h2>Users</h2></div></div>
    <div class="sheet-body">
      <form id="uform" class="fields" style="grid-template-columns:minmax(0,2fr) minmax(0,1.3fr) minmax(0,1fr) auto;align-items:end" novalidate>
        <div class="field"><label for="un">Full name</label><input id="un" maxlength="60" autocomplete="off"></div>
        <div class="field"><label for="ur">Role</label><select id="ur" style="font:inherit;padding:9px 11px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--fg)">
          <option value="wholesale">Wholesale cashier</option><option value="retail">Retail cashier</option><option value="manager">Manager</option><option value="admin">Administrator</option></select></div>
        <div class="field"><label for="up">4-digit PIN</label><input id="up" inputmode="numeric" maxlength="4" autocomplete="off"></div>
        <button class="btn primary" type="submit" id="ubtn">Add user</button>
      </form>
      <div class="msg" id="umsg">Give each person their starting PIN privately. The first time they sign in, the app asks them to choose their own PIN.</div>
    </div>
    <div class="hist">${rows}</div></section>`;
  $("#uform").addEventListener("submit",async e=>{e.preventDefault();const m=$("#umsg");m.className="msg err";
    const n=$("#un").value.trim(),r=$("#ur").value,p=$("#up").value;
    if(n.length<3){m.textContent="Type the person's full name.";return;}
    if(state.users.some(u=>String(u.name).trim().toLowerCase()===n.toLowerCase())){m.textContent="There is already a user with that name. Use a different name, e.g. add a surname.";return;}
    if(!/^\d{4}$/.test(p)){m.textContent="The PIN must be exactly 4 digits.";return;}
    $("#ubtn").disabled=true;
    try{const salt=newSalt();await setDoc(fdoc(usersCol()),{name:n,role:r,active:true,salt,pinHash:await pinHash(salt,p),mustChange:true,createdAt:serverTimestamp()});
      m.className="msg";m.textContent=n+" added. Give them their PIN privately.";$("#un").value="";$("#up").value="";}
    catch(x){m.textContent="Could not save. Check the connection and try again.";}
    $("#ubtn").disabled=false;});
  main.querySelectorAll("button[data-act]").forEach(b=>b.addEventListener("click",async()=>{
    const u=state.users.find(x=>x.id===b.dataset.u);if(!u)return;const m=$("#umsg");
    if(b.dataset.act==="del"){
      if(u.role==="admin"&&state.users.filter(x=>x.role==="admin"&&x.active===true&&x.id!==u.id).length===0){m.className="msg err";m.textContent="You cannot delete the last administrator.";return;}
      if(!confirm("Delete "+u.name+"?\n\nThey will no longer be able to use the app. Cash ups they already signed keep their name and signature."))return;
      // the record is hidden and locked, not erased, so the history stays complete
      try{await setDoc(fdoc(usersCol(),u.id),{active:false,deleted:true,deletedBy:state.me.name,deletedAt:serverTimestamp()},{merge:true});m.className="msg";m.textContent=u.name+" deleted.";}
      catch(x){m.className="msg err";m.textContent="Could not delete. Check the connection and try again.";}return;}
    if(b.dataset.act==="toggle"){try{await setDoc(fdoc(usersCol(),u.id),{active:u.active!==true},{merge:true});}catch(x){m.className="msg err";m.textContent="Could not save.";}return;}
    const row=b.closest(".hrow");row.insertAdjacentHTML("afterend",`<form class="hrow" style="cursor:default" data-pinfor="${esc(u.id)}"><div class="msg">New PIN for ${esc(u.name)}</div><input inputmode="numeric" maxlength="4" style="font:inherit;padding:8px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--fg)"><button class="btn primary" type="submit">Save PIN</button></form>`);
    const f=row.nextElementSibling;f.querySelector("input").focus();
    f.addEventListener("submit",async ev=>{ev.preventDefault();const v=f.querySelector("input").value;
      if(!/^\d{4}$/.test(v)){m.className="msg err";m.textContent="The PIN must be exactly 4 digits.";return;}
      const salt=newSalt();try{await setDoc(fdoc(usersCol(),u.id),{salt,pinHash:await pinHash(salt,v),mustChange:true},{merge:true});m.className="msg";m.textContent="New PIN saved for "+u.name+". They will be asked to choose their own PIN when they next sign in.";f.remove();}
      catch(x){m.className="msg err";m.textContent="Could not save.";}});
  }));
}
function renderHistory(){
  const by={};state.history.forEach(d=>{if(!d||!d.date)return;(by[d.date]=by[d.date]||{})[d.dept]=d;});
  const dates=Object.keys(by).sort().reverse();
  const cell=(d,dept)=>{if(!d)return `<div><div class="eyebrow">${DEPTS[dept]}</div><span class="chip">Not started</span></div>`;const n=normalize(d,d.date,dept);
    return `<div><div class="eyebrow">${DEPTS[dept]}</div>${chip(statusOf(n))} <span class="num msg">${R(totals(n).deposited)}</span></div>`;};
  main.innerHTML=`<section class="sheet">
    <div class="sheet-head"><div><div class="eyebrow">All cash ups</div><h2>History</h2></div></div>
    <div class="hist">${dates.length?dates.map(d=>{const w=by[d].wholesale?normalize(by[d].wholesale,d,"wholesale"):null,r=by[d].retail?normalize(by[d].retail,d,"retail"):null,mg=by[d].manager?normalize(by[d].manager,d,"manager"):null;
      const tot=(w?totals(w).deposited:0)+(r?totals(r).deposited:0),vr=(w?totals(w).variance:0)+(r?totals(r).variance:0);const di=dayInfo(d,w,r,mg);
      return `<button class="hrow" data-d="${esc(d)}"><div><div class="d">${shortDate(d)}</div><span class="chip ${di.cls}" style="margin-top:4px">${di.kind==="done"?"Closed on time":di.kind==="late"?"Closed late":di.kind==="overdue"?"Overdue":di.kind==="sunday"?"Sunday":"Open"}</span></div>${cell(by[d].wholesale,"wholesale")}${cell(by[d].retail,"retail")}<div class="r"><div class="num"><b>${R(tot)}</b></div><div class="num msg ${vcls(vr)}">${RV(vr)}</div></div></button>`;}).join("")
      :`<div class="empty-state">No cash ups yet. Open Wholesale or Retail for today and enter the report and deposited amounts. Each day will appear here.</div>`}</div></section>`;
  main.querySelectorAll(".hrow").forEach(b=>b.addEventListener("click",()=>{$("#date").value=b.dataset.d;setDate(b.dataset.d);setTab("combined");}));
}

window.addEventListener("pagehide",flushAll);
document.addEventListener("visibilitychange",()=>{if(document.visibilityState==="hidden")flushAll();});
setInterval(()=>{if(state.ready&&state.tab!=="users"&&!main.contains(document.activeElement)&&!document.getElementById("pad"))render();},60000); // keep the deadline countdown current
