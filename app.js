import { firebaseConfig, AI_MODEL, APP_CHECK_SITE_KEY } from "./firebase-config.js?v=2026-10-21c";
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.17.1/firebase-app.js";
import { initializeAppCheck, ReCaptchaEnterpriseProvider } from "https://www.gstatic.com/firebasejs/12.17.1/firebase-app-check.js";
import { getFirestore, doc as fdoc, getDocs, setDoc, updateDoc, addDoc, collection, query, where, orderBy, limit, onSnapshot, serverTimestamp } from "https://www.gstatic.com/firebasejs/12.17.1/firebase-firestore.js";

/* ---------- constants & helpers ---------- */
const METHODS=[
  {k:"cash",l:"Cash"},{k:"cashguard",l:"CashGuard"},{k:"card",l:"Credit card"},
  {k:"eft",l:"EFT"},{k:"shop2shop",l:"Shop2Shop"},{k:"snapscan",l:"SnapScan"},
  {k:"petty",l:"Petty cash (not banked)"}   // Aeroton Retail only: cash taken for petty cash, counted but not banked (no report figure)
];
const DEPTS={wholesale:"Wholesale",retail:"Aeroton Retail",citydeep:"City Deep Retail",manager:"Manager",cdmanager:"City Deep manager"};
// City Deep is a separate shop with its own cash up and its own manager sign-off; it is required from this date
const CD_START="2026-10-20";
const cdOn=date=>String(date||"")>=CD_START;
const SHEETS=["wholesale","retail","citydeep"];
const isMgr=d=>d==="manager"||d==="cdmanager";
// One manager signs off the whole day at End of Day (Wholesale, Aeroton Retail and, from CD_START, City Deep Retail)
const mgrOf=d=>"manager";
const sheetsOf=(m,date)=>cdOn(date||state.date)?["wholesale","retail","citydeep"]:["wholesale","retail"];
const hasSplit=d=>d==="retail"||d==="citydeep";                               // CashGuard: Nedbank + counted & retained, not banked
// The two retail shops (Aeroton Retail, City Deep Retail): cash is coins, no EFT line (EFT slips are credit card payments), no Shop2Shop
const isRetail=d=>d==="retail"||d==="citydeep";
const methodsFor=dept=>METHODS.filter(m=>m.k==="petty"?dept==="retail":isRetail(dept)?(m.k!=="eft"&&m.k!=="shop2shop"):true);
const lbl=(m,dept)=>m.k==="cash"?(isRetail(dept)?"Coins":dept==="wholesale"?"Cash":"Cash / Coins (Retail shops)"):m.l;
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

// CashGuard has two "deposited" amounts: banked in Nedbank (deposited) and counted but retained, not yet banked (retained)
const dep=ln=>num(ln&&ln.deposited)+num(ln&&ln.retained);
function blank(date,dept){const lines={};METHODS.forEach(m=>lines[m.k]=m.k==="cashguard"?{report:"",deposited:"",retained:""}:{report:"",deposited:""});
  return {date,dept,cashier:"",lines,damaged:"",damagedNotes:"",notes:"",status:"new",signature:"",signedBy:"",signedAt:"",updatedAt:""};}
function normalize(raw,date,dept){const b=blank(date,dept);if(!raw)return b;const r=Object.assign({},raw);
  // trust the server clock for signature times, not the phone's
  if(raw.signedAtServer&&typeof raw.signedAtServer.toDate==="function")r.signedAt=raw.signedAtServer.toDate().toISOString();
  delete r.signedAtServer;delete r.updatedAtServer;delete r.reopenedAt;
  const o=Object.assign(b,clone(r));METHODS.forEach(m=>{o.lines[m.k]=Object.assign(m.k==="cashguard"?{report:"",deposited:"",retained:""}:{report:"",deposited:""},(raw.lines||{})[m.k]||{});});
  if(!hasSplit(dept))o.lines.cashguard.retained=""; // the "retained, not banked" amount is only on Retail and City Deep
  if(isRetail(dept)){o.lines.shop2shop={report:"",deposited:""};}
  if(isRetail(dept)){const e=o.lines.eft,c=o.lines.card;["report","deposited"].forEach(f=>{if(e[f]!==""&&e[f]!=null){c[f]=(num(c[f])+num(e[f])).toFixed(2);e[f]="";}});}
  return o;}
function totals(doc){let r=0,d=0;methodsFor(doc.dept).forEach(m=>{r+=num(doc.lines[m.k].report);d+=dep(doc.lines[m.k]);});const ret=num(doc.lines.cashguard&&doc.lines.cashguard.retained);const pet=doc.dept==="retail"?num(doc.lines.petty&&doc.lines.petty.deposited):0;return {report:r,deposited:d,variance:d-r,retained:ret,petty:pet,banked:d-ret-pet};}

/* Deadline: every trading day Mon–Sat, all three signatures by 19:00 */
function dayInfo(date,W,Rt,M,C,CM){const [y,m,d]=date.split("-").map(Number);const dt=new Date(y,m-1,d);
  if(dt.getDay()===0)return {kind:"sunday",label:"Sunday · not a trading day",cls:"",missing:[]};
  const dl=new Date(y,m-1,d,19,0,0);const missing=[];const all=[W,Rt,M];
  if(!(W&&W.status==="signed"))missing.push("Wholesale");if(!(Rt&&Rt.status==="signed"))missing.push("Aeroton Retail");if(!(M&&M.status==="signed"))missing.push("Manager");
  if(cdOn(date)){all.push(C);if(!(C&&C.status==="signed"))missing.push("City Deep Retail");}
  if(!missing.length){const last=Math.max(...all.map(x=>Date.parse(x.signedAt)||0));
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

const state={date:todayStr(),tab:"wholesale",docs:{wholesale:null,retail:null,manager:null,citydeep:null,cdmanager:null},history:[],pending:{},key:null,ready:false,users:[],me:null};
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
const ROLE_LABEL={wholesale:"Wholesale cashier",retail:"Aeroton Retail cashier",citydeep:"City Deep Retail cashier",manager:"Manager",admin:"Administrator"};
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
  $("#tab-users").hidden=role()!=="admin";
  $("#tab-notbanked").hidden=!["manager","admin"].includes(role());}
function lockApp(msg){flushAll();showWho(msg);}
let idleT=null;
function resetIdle(){clearTimeout(idleT);if(state.me)idleT=setTimeout(()=>lockApp("Locked after 15 minutes without use. Tap your name to continue."),15*60000);}
["pointerdown","keydown"].forEach(ev=>document.addEventListener(ev,resetIdle,{passive:true}));

/* ---------- app start ---------- */
function startApp(){
  $("#tabs").hidden=false;$("#datebox").hidden=false;whoBar();state.ready=true;resetIdle();
  $("#foot").textContent="Live sync active · shared by all cashiers · App version 2026-10-21c";
  const r=role();state.tab=r==="retail"?"retail":r==="citydeep"?"citydeep":r==="manager"?"combined":"wholesale";
  if(state.tab==="users"&&r!=="admin")state.tab="wholesale";
  state.date=todayStr();$("#date").value=state.date;
  Object.keys(local).forEach(k=>delete local[k]);
  subscribeDay();subscribeHistory();setTab(state.tab);
}
$("#date").addEventListener("change",e=>{if(e.target.value)setDate(e.target.value);});
$("#today").addEventListener("click",()=>{$("#date").value=todayStr();setDate(todayStr());});
document.querySelectorAll("nav.tabs button").forEach(b=>b.addEventListener("click",()=>setTab(b.dataset.tab)));
function setTab(t){if(t==="users"&&role()!=="admin")t="wholesale";state.tab=t;SHEETS.forEach(d=>document.querySelector("header.bar").classList.toggle("dept-"+d,t===d));
  document.querySelectorAll("nav.tabs button").forEach(b=>b.setAttribute("aria-selected",String(b.dataset.tab===t)));render(true);}
function setDate(d){flushAll();state.date=d;state.docs={wholesale:null,retail:null,manager:null,citydeep:null,cdmanager:null};Object.keys(DEPTS).forEach(k=>delete local[k]);subscribeDay();render(true);}
function stopSubs(){if(photoSub){photoSub();photoSub=null;}if(daySub){daySub();daySub=null;}if(histSub){histSub();histSub=null;}}

function canReopen(dept){if(isMgr(dept))return canSignManager();const M=current(mgrOf(dept));if(["manager","admin"].includes(role()))return M.status!=="signed";return current(dept).signedBy===state.me.name&&M.status!=="signed";}
function dayNow(){return dayInfo(state.date,current("wholesale"),current("retail"),current("manager"),current("citydeep"),current("cdmanager"));}
function current(dept){if(!local[dept])local[dept]=normalize(state.docs[dept],state.date,dept);return local[dept];}
function statusOf(doc){if(!doc)return "new";return doc.status==="signed"?"signed":(doc.status==="draft"?"draft":"new");}
function chip(st){return st==="signed"?'<span class="chip signed">Signed off</span>':st==="draft"?'<span class="chip draft">In progress</span>':'<span class="chip">Not started</span>';}
function updateDots(){SHEETS.forEach(d=>{const st=statusOf(local[d]||state.docs[d]);$("#dot-"+d).className="dot "+(st==="new"?"":st);});}

/* ---------- persistence ---------- */
function idOf(dept,date){return (date||state.date)+"_"+dept;}
function scheduleSave(dept){const doc=local[dept];if(doc.status==="new")doc.status="draft";
  if(!isMgr(dept)&&!doc.cashier)doc.cashier=state.me.name;
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
    if(opts.action){try{await addDoc(collection(db,"shops",state.key,"cashups",idOf(dept,doc.date),"history"),{name:String(opts.by||doc.signedBy||"").slice(0,80),action:opts.action,at:serverTimestamp(),totals:isMgr(dept)?null:totals(doc)});}catch(e){}}
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
    const got={wholesale:null,retail:null,manager:null,citydeep:null,cdmanager:null};
    snap.docs.forEach(d=>{const v=d.data();if(v&&Object.prototype.hasOwnProperty.call(got,v.dept))got[v.dept]=v;});
    let needRender=false;
    Object.keys(got).forEach(dept=>{
      state.docs[dept]=got[dept];
      if(state.pending[dept]){
        // someone signed this sheet while we had unsaved typing: drop our stale draft
        if(got[dept]&&got[dept].status==="signed"&&local[dept]&&local[dept].status!=="signed"){clearTimeout(timers[dept]);state.pending[dept]=false;}
        else return;}
      const fresh=normalize(got[dept],date,dept);
      if(!local[dept]||JSON.stringify(fresh)!==JSON.stringify(local[dept])){
        const statusChanged=!local[dept]||local[dept].status!==fresh.status;
        local[dept]=fresh;
        if(state.tab===dept||(dept==="cdmanager"&&state.tab==="citydeep")){if(dept==="cdmanager"||statusChanged||!main.contains(document.activeElement))needRender=true;else patchInputs(dept);}
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
  if(SHEETS.includes(state.tab))renderDept(state.tab);
  else if(state.tab==="combined")renderCombined();else if(state.tab==="notbanked")renderNotBanked();else renderHistory();}

function banner(di){if(di.kind==="sunday")return "";
  return `<div class="banner ${di.kind==="done"?"ok":di.kind==="overdue"?"bad":"wait"}" style="font-weight:500">${di.kind==="overdue"?"Past the 7 pm deadline. Missing: "+di.missing.join(", ")+".":di.kind==="open"?di.label+". "+(cdOn(state.date)?"Wholesale, Aeroton Retail, City Deep Retail and the manager":"Wholesale, Aeroton Retail and the manager")+" must all sign.":di.label+"."}</div>`;}

function cgNote(t){const p=t.petty?` · petty cash, not banked: <b>${R(t.petty)}</b>`:"";return (t.retained||t.petty)?`Includes CashGuard counted &amp; retained, not banked: <b>${R(t.retained)}</b>${p}. Banked total: ${R(t.banked)}.`:"Nothing kept back: everything counted was banked.";}
function renderDept(dept){
  const doc=current(dept),signed=doc.status==="signed",editable=!signed&&canEditDept(dept),dis=editable?"":"disabled";
  const t=totals(doc);
  const inA=`inputmode="decimal" autocomplete="off" autocorrect="off" spellcheck="false" data-lpignore="true" data-form-type="other" placeholder="0.00" ${dis}`;
  const rows=methodsFor(dept).map(m=>{const ln=doc.lines[m.k];const v=dep(ln)-num(ln.report);
    if(m.k==="petty")return `<tr class="petty"><td>${m.l}<div class="msg" style="font-size:.72rem;font-weight:400">Cash kept for petty cash</div></td>
      <td class="num muted">—</td>
      <td class="inp"><input id="${dept}-petty-deposited" data-m="petty" data-f="deposited" inputmode="decimal" autocomplete="off" autocorrect="off" spellcheck="false" data-lpignore="true" data-form-type="other" placeholder="0.00" value="${esc(ln.deposited)}" ${dis} aria-label="Petty cash, not banked"></td>
      <td class="num muted">—</td></tr>`;
    if(m.k==="cashguard"&&hasSplit(dept))return `<tr class="cg"><td>${m.l}</td>
      <td class="inp"><input id="${dept}-cashguard-report" data-m="cashguard" data-f="report" ${inA} value="${esc(ln.report)}" aria-label="CashGuard per report"></td>
      <td class="inp"><label class="sub" for="${dept}-cashguard-deposited">Deposited in Nedbank</label><input id="${dept}-cashguard-deposited" data-m="cashguard" data-f="deposited" ${inA} value="${esc(ln.deposited)}" aria-label="CashGuard deposited in Nedbank">
        <label class="sub" for="${dept}-cashguard-retained">Counted &amp; retained, not banked</label><input id="${dept}-cashguard-retained" data-m="cashguard" data-f="retained" ${inA} value="${esc(ln.retained)}" aria-label="CashGuard counted and retained, not banked"></td>
      <td class="num ${vcls(v)}" id="v-cashguard">${RV(v)}</td></tr>`;
    return `<tr><td>${lbl(m,dept)}</td>
      <td class="inp"><input id="${dept}-${m.k}-report" data-m="${m.k}" data-f="report" inputmode="decimal" autocomplete="off" autocorrect="off" spellcheck="false" data-lpignore="true" data-form-type="other" placeholder="0.00" value="${esc(ln.report)}" ${dis} aria-label="${lbl(m,dept)} per report"></td>
      <td class="inp"><input id="${dept}-${m.k}-deposited" data-m="${m.k}" data-f="deposited" inputmode="decimal" autocomplete="off" autocorrect="off" spellcheck="false" data-lpignore="true" data-form-type="other" placeholder="0.00" value="${esc(ln.deposited)}" ${dis} aria-label="${lbl(m,dept)} deposited"></td>
      <td class="num ${vcls(v)}" id="v-${m.k}">${RV(v)}</td></tr>`;}).join("");
  const di=dayNow();
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
        <div style="min-width:0"><div class="eyebrow">Fill from photo</div><div class="msg">Take a photo of the last page of the cash up report, or attach a saved photo or PDF. The report figures are filled in for you to check, and a copy is kept with this cash up.</div></div>
        <div class="actions">
          <label class="btn primary" for="${dept}-photo" style="display:inline-flex;align-items:center;gap:8px">Scan report photo</label>
          <label class="btn" for="${dept}-photo2" style="display:inline-flex;align-items:center;gap:8px">Add another photo</label>
          <label class="btn" for="${dept}-file" style="display:inline-flex;align-items:center;gap:8px">Attach file</label>
        </div>
        <input type="file" id="${dept}-photo" accept="image/*" capture="environment" hidden>
        <input type="file" id="${dept}-photo2" accept="image/*" capture="environment" hidden>
        <input type="file" id="${dept}-file" accept="image/*,application/pdf,.pdf" multiple hidden>
        <div class="msg" id="scan-msg" style="flex-basis:100%"></div>
      </div>`:""}
      <div class="field"><label>Report photos</label><div data-photos="${dept}">${photoStrip(dept)}</div></div>
      <div class="tbl-wrap"><table>
        <thead><tr><th>Payment type</th><th>Per report<small>Till / Z-report</small></th><th>Deposited<small>Actual counted</small></th><th>Variance<small>Deposited − report</small></th></tr></thead>
        <tbody>${rows}</tbody>
        <tfoot><tr><td>Total</td><td class="num" id="t-report">${R(t.report)}</td><td class="num" id="t-dep">${R(t.deposited)}</td><td class="num ${vcls(t.variance)}" id="t-var">${RV(t.variance)}</td></tr>
        ${hasSplit(dept)?`<tr class="cgnote"><td colspan="4" id="t-cg">${cgNote(t)}</td></tr>`:""}</tfoot>
      </table></div>
      <div class="dmg">
        <div class="field"><label for="${dept}-damaged">Damaged bank notes &amp; coins (R)</label><input id="${dept}-damaged" class="num" inputmode="decimal" autocomplete="off" autocorrect="off" spellcheck="false" data-lpignore="true" data-form-type="other" placeholder="0.00" value="${esc(doc.damaged)}" ${dis} style="text-align:right"></div>
        <div class="field"><label for="${dept}-damagedNotes">Damaged details</label><input id="${dept}-damagedNotes" value="${esc(doc.damagedNotes)}" placeholder="e.g. 1 × R100 torn, 3 × R5 coins bent" autocomplete="off" ${dis} maxlength="300"></div>
      </div>
      ${dept==="retail"?`<div class="field"><label for="${dept}-pettyNotes">Petty cash details</label><input id="${dept}-pettyNotes" value="${esc(doc.pettyNotes||"")}" placeholder="e.g. R200 for cleaning materials, slip in petty cash box" autocomplete="off" ${dis} maxlength="300"></div>`:""}
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
    <div class="msg">This ${isMgr(dept)?"day":"cash up"} is locked.${canReopen(dept)?" Reopen it only to correct a mistake; the signature is removed, the reopen is recorded, and it must be signed again.":` The manager has closed the day, so only the manager can reopen it from End of Day.`}</div>
    ${canReopen(dept)?`<div class="actions"><button class="btn danger" id="reopen" data-dept="${dept}">Reopen to correct</button><span class="msg" id="reopen-msg"></span></div>`:""}
  </div></div>`;}
function signBlock(doc,dept){return `<div class="sign">
  <div class="pad"><canvas id="pad" data-dept="${dept}" width="900" height="300" aria-label="Signature pad"></canvas><div class="base"></div><div class="hint">Sign above the line with finger or mouse</div></div>
  <div style="display:flex;flex-direction:column;gap:10px">
    <div class="msg">${dept==="manager"?`By signing, I confirm I have checked the ${cdOn(state.date)?"Wholesale, Aeroton Retail and City Deep Retail":"Wholesale and Aeroton Retail"} cash ups for ${shortDate(state.date)} and the combined totals are correct.`:dept==="cdmanager"?`By signing, I confirm I have checked the City Deep Retail cash up for ${shortDate(state.date)} and the totals are correct.`:`By signing, I confirm the amounts deposited for ${DEPTS[dept]} on ${shortDate(state.date)} are correct.`}</div>
    <div><div class="eyebrow">Signing as</div><div class="signer-static">${esc(state.me.name)}</div></div>
    <div class="actions"><button class="btn" id="clear" type="button">Clear</button><button class="btn primary" id="signbtn" type="button">Sign &amp; submit</button></div>
    <div class="msg" id="sign-msg"></div>
  </div></div>`;}

function patchInputs(dept){const doc=local[dept];
  METHODS.forEach(m=>["report","deposited","retained"].forEach(f=>{const el=document.getElementById(dept+"-"+m.k+"-"+f);if(el&&el!==document.activeElement)el.value=doc.lines[m.k][f]||"";}));
  [["notes","notes"],["damaged","damaged"],["damagedNotes","damagedNotes"],["pettyNotes","pettyNotes"]].forEach(([id,k])=>{const el=document.getElementById(dept+"-"+id);if(el&&el!==document.activeElement)el.value=doc[k]||"";});
  recalc(dept);}
function recalc(dept){const doc=local[dept];
  METHODS.forEach(m=>{const v=dep(doc.lines[m.k])-num(doc.lines[m.k].report);const el=document.getElementById("v-"+m.k);if(el){el.textContent=RV(v);el.className="num "+vcls(v);}});
  const t=totals(doc),a=$("#t-report"),b=$("#t-dep"),c=$("#t-var");
  if(a){a.textContent=R(t.report);b.textContent=R(t.deposited);c.textContent=RV(t.variance);c.className="num "+vcls(t.variance);}
  const g=$("#t-cg");if(g)g.innerHTML=cgNote(t);}
// Amounts: accept a comma or a point as the decimal mark, keep at most 2 decimals
// Amounts may be typed with a comma or a point for the cents: 1480,55 / 1480.55 / 1 480,55 / 1.480,55 / 1,480.55
// The last comma or point is the decimal mark (1 or 2 digits after it); 3 digits after it means a thousands separator.
const money=v=>{const t=String(v==null?"":v).replace(/[^0-9.,]/g,"");
  const last=Math.max(t.lastIndexOf("."),t.lastIndexOf(","));
  if(last<0)return t.slice(0,12);
  const whole=t.slice(0,last).replace(/[.,]/g,""),dec=t.slice(last+1).replace(/[.,]/g,"");
  if(dec.length>=3)return (whole+dec).slice(0,12);
  return (whole||"0")+"."+dec;};

function bindDept(dept){
  // always write into the CURRENT copy of the sheet: it is replaced whenever the database sends an update
  const D=()=>local[dept];
  main.querySelectorAll("td.inp input").forEach(inp=>{
    // clicking into a box selects the amount, so typing simply replaces it
    inp.addEventListener("focus",()=>{try{inp.select();}catch(e){}});
    inp.addEventListener("mouseup",e=>{if(inp.dataset.sel!=="1"){e.preventDefault();inp.dataset.sel="1";}});
    inp.addEventListener("blur",()=>{inp.dataset.sel="";});
    // leave what the person types alone (comma or point); only strip letters. Tidy to 2 decimals on leaving the box.
    inp.addEventListener("input",()=>{if(/[^0-9.,]/.test(inp.value))inp.value=inp.value.replace(/[^0-9.,]/g,"");D().lines[inp.dataset.m][inp.dataset.f]=money(inp.value);recalc(dept);scheduleSave(dept);});
    inp.addEventListener("blur",()=>{if(inp.value!==""){const v=num(money(inp.value)).toFixed(2);inp.value=v;D().lines[inp.dataset.m][inp.dataset.f]=v;scheduleSave(dept);}});});
  const n=document.getElementById(dept+"-notes");if(n)n.addEventListener("input",()=>{D().notes=n.value;scheduleSave(dept);});
  const dm=document.getElementById(dept+"-damaged");if(dm){dm.addEventListener("focus",()=>{try{dm.select();}catch(e){}});dm.addEventListener("mouseup",e=>{if(dm.dataset.sel!=="1"){e.preventDefault();dm.dataset.sel="1";}});dm.addEventListener("blur",()=>{dm.dataset.sel="";});dm.addEventListener("input",()=>{if(/[^0-9.,]/.test(dm.value))dm.value=dm.value.replace(/[^0-9.,]/g,"");D().damaged=money(dm.value);scheduleSave(dept);});
    dm.addEventListener("blur",()=>{if(dm.value!==""){dm.value=num(money(dm.value)).toFixed(2);D().damaged=dm.value;scheduleSave(dept);}});}
  const dn=document.getElementById(dept+"-damagedNotes");if(dn)dn.addEventListener("input",()=>{D().damagedNotes=dn.value;scheduleSave(dept);});
  const pn=document.getElementById(dept+"-pettyNotes");if(pn)pn.addEventListener("input",()=>{D().pettyNotes=pn.value;scheduleSave(dept);});
  const ro=$("#reopen");if(ro){const rdept=ro.dataset.dept||dept;let armed=false;ro.addEventListener("click",async()=>{
    if(!armed){armed=true;ro.textContent="Tap again to reopen";$("#reopen-msg").textContent="The signature will be removed.";setTimeout(()=>{armed=false;if(ro.isConnected){ro.textContent="Reopen to correct";$("#reopen-msg").textContent="";}},4000);return;}
    ro.disabled=true;
    const mk=mgrOf(rdept),M=current(mk);
    if(!isMgr(rdept)&&M.status==="signed"){
      if(!["manager","admin"].includes(role())){ro.disabled=false;$("#reopen-msg").textContent="The day is closed. Ask the manager to reopen it.";return;}
      Object.assign(M,{status:"draft",signature:"",signedBy:"",signedAt:""});state.pending[mk]=true;
      if(!await save(mk,{action:"reopened",by:state.me.name})){ro.disabled=false;$("#reopen-msg").textContent="Could not reopen the day. Try again.";return;}}
    Object.assign(current(rdept),{status:"draft",signature:"",signedBy:"",signedAt:""});clearTimeout(timers[rdept]);state.pending[rdept]=true;
    await save(rdept,{action:"reopened",by:state.me.name});render(true);});}
  const pad=$("#pad");if(pad)bindPad(pad,pad.dataset.dept||dept);
  const ph=document.getElementById(dept+"-photo");if(ph)ph.addEventListener("change",()=>{const f=ph.files&&ph.files[0];ph.value="";if(f)scanPhoto(f,dept,true);});
  const fl=document.getElementById(dept+"-file");if(fl)fl.addEventListener("change",()=>{const fs=Array.from(fl.files||[]);fl.value="";if(fs.length)attachFiles(fs,dept);});
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
    if(isMgr(dept)){const sh=sheetsOf(dept).map(current);
      if(!sh.every(x=>x.status==="signed")){msg.textContent=cdOn(state.date)?"Wholesale, Aeroton Retail and City Deep Retail must all sign first.":"Wholesale and Aeroton Retail must both sign first.";return;}
      const nm=state.me.name.trim().toLowerCase();
      if(nm&&sh.some(x=>nm===String(x.signedBy).trim().toLowerCase())){msg.textContent="The manager sign-off must be done by a different person from the cashier who signed.";return;}}
    else{const t=totals(doc);if(t.report===0&&t.deposited===0){msg.textContent="Enter the report and deposited amounts before signing.";return;}}
    const who=state.me.name;
    if(!inked){msg.textContent="Draw the signature in the box first.";return;}
    const out=document.createElement("canvas");out.width=600;out.height=200;const o=out.getContext("2d");o.fillStyle="#fff";o.fillRect(0,0,600,200);o.drawImage(cv,0,0,600,200);
    const before=clone(doc);
    Object.assign(doc,{signature:out.toDataURL("image/png"),signedBy:who,signedAt:new Date().toISOString(),status:"signed"});
    if(!isMgr(dept)&&!doc.cashier)doc.cashier=who;
    clearTimeout(timers[dept]);state.pending[dept]=true;$("#signbtn").disabled=true;msg.className="msg";msg.textContent="Signing…";
    const ok=await save(dept,{signing:true,action:"signed",by:who});
    if(!ok){local[dept]=before;render(true);const m2=$("#sign-msg");if(m2){m2.className="msg err";m2.textContent="Not signed. Check the connection and try again.";}return;}
    render(true);});
}

function renderCombined(){
  const W=current("wholesale"),Rt=current("retail"),M=current("manager"),C=current("citydeep"),CM=current("cdmanager");
  const tw=totals(W),tr=totals(Rt),tc=totals(C);
  const showCD=cdOn(state.date)||statusOf(C)!=="new";
  const info=dayNow();const both=W.status==="signed"&&Rt.status==="signed";
  const S=showCD?[["wholesale",W,tw],["retail",Rt,tr],["citydeep",C,tc]]:[["wholesale",W,tw],["retail",Rt,tr]];
  const sum=f=>S.reduce((a,[, ,t])=>a+t[f],0);
  const gr=sum("report"),gd=sum("deposited"),gv=gd-gr,gret=sum("retained");
  const banked=S.reduce((a,[,d])=>a+["cash","cashguard"].reduce((x,k)=>x+num(d.lines[k].deposited),0),0);
  const need=S.map(([d,doc])=>[d,doc]);const waiting=need.filter(([,doc])=>doc.status!=="signed").map(([d])=>DEPTS[d]);
  const mgrBlock=M.status==="signed"?signedBlock(M,"manager"):!canSignManager()?`<div class="msg">Only a manager can sign off the day. ${waiting.length?"Still waiting for: "+waiting.join(", ")+".":"Waiting for the manager."}</div>`:!waiting.length?signBlock(M,"manager"):`<div class="msg">You can sign here once all shops have signed. Still waiting for: ${waiting.join(", ")}.</div>`;
  const shopCols=S.map(([d])=>`<th colspan="2" class="grp" style="text-align:center">${DEPTS[d]}</th>`).join("");
  const shopSub=S.map(()=>`<th class="grp">Report</th><th>Deposited</th>`).join("");
  const rows=METHODS.map(m=>{let r=0,dd=0;const cells=S.map(([d,doc])=>{const on=methodsFor(d).some(x=>x.k===m.k);const a=on?num(doc.lines[m.k].report):0,b=on?dep(doc.lines[m.k]):0;r+=a;dd+=b;
      return on?`<td class="num grp">${R(a)}</td><td class="num">${R(b)}</td>`:`<td class="num grp muted">—</td><td class="num muted">—</td>`;}).join("");const v=dd-r;
    return `<tr><td>${lbl(m,"combined")}</td>${cells}<td class="num grp"><b>${R(r)}</b></td><td class="num"><b>${R(dd)}</b></td><td class="num ${vcls(v)}">${RV(v)}</td></tr>`;}).join("");
  const foot=S.map(([, ,t])=>`<td class="num grp">${R(t.report)}</td><td class="num">${R(t.deposited)}</td>`).join("");
  const sig=(doc,dept)=>{const img=safeImg(doc.signature);return `<div class="sigbox"><div class="eyebrow">${DEPTS[dept]}</div>${doc.status==="signed"?`<div class="sig-img">${img?`<img src="${img}" alt="${DEPTS[dept]} signature">`:""}</div><div class="who">${esc(doc.signedBy)} · ${timeStr(doc.signedAt)}</div>`:`<div class="empty">Awaiting signature</div><div class="who">${isMgr(dept)?"signed below":(doc.cashier?esc(doc.cashier)+" · ":"")+(statusOf(doc)==="draft"?"in progress":"not started")}</div>`}</div>`;};
  const stat=(d,l)=>chip(statusOf(d)).replace("Signed off",l+" signed").replace("In progress",l+" in progress").replace("Not started",l+" not started");
  const each=(f,label)=>S.map(([d,doc])=>`<b>${DEPTS[d]}:</b> ${f(doc,d)}`).join(" · ");
  const notes=S.filter(([,d])=>d.notes).map(([d,doc])=>`<b>${DEPTS[d]}:</b> ${esc(doc.notes)}`).join("\n");
  const splitShops=S.filter(([d])=>hasSplit(d));
  main.innerHTML=`
  <div class="banner ${info.kind==="done"?"ok":info.kind==="overdue"?"bad":"wait"}">${info.kind==="done"?"Day closed on time. All cash ups and the manager have signed.":info.kind==="late"?"Day closed, but after the 7 pm deadline. "+info.label+".":info.kind==="overdue"?"Past the 7 pm deadline. Missing signature: "+info.missing.join(", ")+". Ulla is notified by email.":info.kind==="sunday"?"Sunday is not a trading day.":"Day still open. "+info.label+". Still to sign: "+info.missing.join(", ")+"."}</div>
  <div class="eyebrow" style="margin:4px 0 8px">${showCD?"All shops together · Aeroton (Wholesale + Aeroton Retail) and City Deep Retail":"Aeroton · Wholesale + Aeroton Retail"}</div>
  <div class="summary">
    <div class="stat"><div class="k">Per reports</div><div class="v num">${R(gr)}</div></div>
    <div class="stat"><div class="k">Deposited</div><div class="v num">${R(gd)}</div></div>
    <div class="stat"><div class="k">Variance</div><div class="v num ${vcls(gv)}">${RV(gv)}</div></div>
    <div class="stat"><div class="k">Not banked<br><span style="font-weight:400;text-transform:none;letter-spacing:0">CashGuard retained + petty cash</span></div><div class="v num">${R(gret+sum("petty"))}</div></div>
    <div class="stat"><div class="k">Cash + CashGuard banked</div><div class="v num">${R(banked)}</div></div>
  </div>
  <section class="sheet">
    <div class="sheet-head"><div><div class="eyebrow">Combined end-of-day cash up</div><h2>${longDate(state.date)}</h2></div><div class="actions">${S.map(([d,doc])=>stat(doc,DEPTS[d])).join("")}</div></div>
    <div class="sheet-body">
      <div class="tbl-wrap"><table style="min-width:${showCD?1040:820}px">
        <thead><tr><th rowspan="2">Payment type</th>${shopCols}<th colspan="3" class="grp" style="text-align:center">${showCD?"All shops":"Combined"}</th></tr>
        <tr>${shopSub}<th class="grp">Report</th><th>Deposited</th><th>Variance</th></tr></thead>
        <tbody>${rows}</tbody>
        <tfoot><tr><td>Total</td>${foot}<td class="num grp">${R(gr)}</td><td class="num">${R(gd)}</td><td class="num ${vcls(gv)}">${RV(gv)}</td></tr></tfoot>
      </table></div>
      ${showCD?`<div class="fields" style="grid-template-columns:repeat(3,minmax(0,1fr))">
        <div class="field"><label>Aeroton variance</label><div class="static num ${vcls(tw.variance+tr.variance)}">${RV(tw.variance+tr.variance)}</div></div>
        <div class="field"><label>City Deep Retail variance</label><div class="static num ${vcls(tc.variance)}">${RV(tc.variance)}</div></div>
        <div class="field"><label>All shops variance</label><div class="static num ${vcls(gv)}">${RV(gv)}</div></div></div>`:""}
      <div class="field"><label>Cashed up by</label><div class="static" style="font-weight:400">${each(d=>esc(d.cashier)||"—")}</div></div>
      ${notes?`<div class="field"><label>Notes</label><div class="static" style="font-weight:400;white-space:pre-wrap">${notes}</div></div>`:""}
      <div class="field"><label>CashGuard</label><div class="static num" style="font-weight:400">${splitShops.map(([d,doc,t])=>`<b>${DEPTS[d]}:</b> deposited in Nedbank ${R(num(doc.lines.cashguard.deposited))} · counted &amp; retained, not banked <b>${R(t.retained)}</b>`).join("<br>")}</div></div>
      ${tr.petty||Rt.pettyNotes?`<div class="field"><label>Aeroton Retail petty cash (not banked)</label><div class="static num" style="font-weight:400"><b>${R(tr.petty)}</b>${Rt.pettyNotes?" · "+esc(Rt.pettyNotes):""}</div></div>`:""}
      <div class="field"><label>Damaged bank notes &amp; coins</label><div class="static num" style="font-weight:400">${each((d)=>R(num(d.damaged))+(d.damagedNotes?" ("+esc(d.damagedNotes)+")":""))} · <b>Total ${R(S.reduce((a,[,d])=>a+num(d.damaged),0))}</b></div></div>
      <div class="fields" style="grid-template-columns:repeat(${S.length},minmax(0,1fr))">
        ${S.map(([d])=>`<div class="field"><label>${DEPTS[d]} report photos</label><div data-photos="${d}">${photoStrip(d)}</div></div>`).join("")}
      </div>
      <div class="sigs">${sig(W,"wholesale")}${sig(Rt,"retail")}${showCD?sig(C,"citydeep"):""}${sig(M,"manager")}</div>
      <div class="actions"><button class="btn primary" id="pdf-mail" type="button">Email PDF report</button><button class="btn" id="pdf-dl" type="button">Download PDF</button><button class="btn" id="csv">Download day as CSV</button><span class="msg" id="csv-msg"></span></div>
    </div>
  </section>
  <section class="sheet">
    <div class="sheet-head"><div><div class="eyebrow">End-of-day sign-off · ${showCD?"all shops":"Wholesale + Aeroton Retail"} · due by 7 pm</div><h2>Manager signature</h2></div>${M.status==="signed"?'<span class="chip signed">Signed off</span>':'<span class="chip">Not signed</span>'}</div>
    <div class="sheet-body">${mgrBlock}</div>
  </section>
`;
  local.manager=M;bindDept("manager");
  $("#pdf-dl").addEventListener("click",()=>pdfAction("download"));
  $("#pdf-mail").addEventListener("click",()=>pdfAction("email"));
  $("#csv").addEventListener("click",()=>{
    const f=x=>typeof x==="number"?x.toFixed(2):x;
    const head=["Payment type"];S.forEach(([d])=>head.push(DEPTS[d]+" report",DEPTS[d]+" deposited"));head.push("All shops report","All shops deposited","Variance");
    const lines=[["Date",state.date],[],head];
    METHODS.forEach(m=>{let r=0,dd=0;const row=[lbl(m,"combined")];S.forEach(([d,doc])=>{const on=methodsFor(d).some(x=>x.k===m.k);const a=on?num(doc.lines[m.k].report):0,b=on?dep(doc.lines[m.k]):0;r+=a;dd+=b;row.push(a,b);});row.push(r,dd,dd-r);lines.push(row.map(f));});
    const tot=["Total"];S.forEach(([, ,t])=>tot.push(t.report,t.deposited));tot.push(gr,gd,gv);lines.push(tot.map(f));
    lines.push([]);
    S.forEach(([d,doc,t])=>{lines.push([DEPTS[d]+" cashed up by",doc.cashier,"Signed by",doc.signedBy,doc.signedAt],[DEPTS[d]+" notes",doc.notes],["Damaged notes & coins - "+DEPTS[d],num(doc.damaged).toFixed(2),doc.damagedNotes]);
      if(d==="retail")lines.push(["Aeroton Retail petty cash (not banked)",t.petty.toFixed(2),doc.pettyNotes||""]);
      if(hasSplit(d))lines.push([DEPTS[d]+" CashGuard deposited in Nedbank",num(doc.lines.cashguard.deposited).toFixed(2)],[DEPTS[d]+" CashGuard counted & retained, not banked",t.retained.toFixed(2)]);});
    lines.push(["Manager signed by",M.signedBy,M.signedAt]);lines.push(["Day status",info.label]);
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
async function makePdf(){const [{buildReportPdf,reportFileName},jsPDF]=await Promise.all([import("./report-pdf.js?v=2026-10-21c"),loadJsPDF()]);
  const W=current("wholesale"),Rt=current("retail"),M=current("manager"),C=current("citydeep"),CM=current("cdmanager");const info=dayNow();
  const showCD=cdOn(state.date)||statusOf(C)!=="new";
  const photos=state.photos.filter(p=>p.removed!==true&&safeJpg(p.data)).sort((a,b)=>a.dept.localeCompare(b.dept)||String(a.takenAt||"").localeCompare(String(b.takenAt||"")));
  const pdf=buildReportPdf(jsPDF,{date:state.date,niceDate:longDate(state.date),W,Rt,M,C:showCD?C:null,CM:showCD?CM:null,status:info.label,photos});
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
/* ---------- attached files (photos or PDFs) ---------- */
let pdfjsLib=null;
function loadPdfJs(){if(pdfjsLib)return Promise.resolve(pdfjsLib);
  return new Promise((res,rej)=>{const sc=document.createElement("script");sc.src="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js";
    sc.onload=()=>{pdfjsLib=window.pdfjsLib;if(!pdfjsLib)return rej(new Error("PDF reader did not load"));
      pdfjsLib.GlobalWorkerOptions.workerSrc="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";res(pdfjsLib);};
    sc.onerror=()=>rej(new Error("PDF reader could not be downloaded"));document.head.appendChild(sc);});}
// Turn each PDF page into a JPEG picture (max 6 pages) so it is kept and read exactly like a photo.
async function pdfToImages(file){const lib=await loadPdfJs();const pdf=await lib.getDocument({data:await file.arrayBuffer()}).promise;
  const out=[];const n=Math.min(pdf.numPages,6);
  for(let i=1;i<=n;i++){const page=await pdf.getPage(i);const vp0=page.getViewport({scale:1});const vp=page.getViewport({scale:Math.min(3,2000/Math.max(vp0.width,vp0.height))});
    const c=document.createElement("canvas");c.width=Math.round(vp.width);c.height=Math.round(vp.height);const x=c.getContext("2d");x.fillStyle="#fff";x.fillRect(0,0,c.width,c.height);
    await page.render({canvasContext:x,viewport:vp}).promise;
    out.push(await new Promise(r=>c.toBlob(b=>r(new File([b],file.name.replace(/\.pdf$/i,"")+"-p"+i+".jpg",{type:"image/jpeg"})),"image/jpeg",0.92)));}
  return {images:out,total:pdf.numPages};}
async function attachFiles(files,dept){const say=(t,err)=>{const m=$("#scan-msg");if(m){m.className="msg"+(err?" err":"");m.textContent=t;}};
  const imgs=[];let readIdx=0,note="";
  for(const f of files){
    const isPdf=f.type==="application/pdf"||/\.pdf$/i.test(f.name);
    if(isPdf){say("Opening "+f.name+"…");
      try{const r=await pdfToImages(f);if(!r.images.length)continue;
        if(!imgs.length)readIdx=r.images.length-1; // the totals are on the last page
        imgs.push(...r.images);if(r.total>r.images.length)note=" Only the first "+r.images.length+" pages of "+f.name+" were kept.";}
      catch(e){console.error("PDF:",e);say("The PDF "+f.name+" could not be opened: "+(e&&e.message||e),true);return;}}
    else if(/^image\//.test(f.type)||/\.(jpe?g|png|heic|webp|gif|bmp)$/i.test(f.name))imgs.push(f);
    else{say(f.name+" is not a photo or PDF. Attach a photo (JPG, PNG) or a PDF.",true);return;}}
  if(!imgs.length){say("Nothing to attach.",true);return;}
  // save every page/photo; read the figures from one of them (the PDF's last page, or the first photo)
  for(let i=0;i<imgs.length;i++){if(i!==readIdx)await scanPhoto(imgs[i],dept,false);}
  await scanPhoto(imgs[readIdx],dept,true);
  if(note){const m=$("#scan-msg");if(m)m.textContent+=note;}}
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
- card: Credit card / debit card / speedpoint / card machine totals combined${isRetail(dept)?" (in this shop, amounts printed as EFT are card-machine payments: include them here)":""}
- eft: EFT / bank transfer${isRetail(dept)?" (always null for this shop: put EFT amounts under card)":""}
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
  const vals={};METHODS.forEach(m=>{let v=null;for(const k of alias[m.k]){if(low[k]!=null){v=toNum(low[k]);break;}}vals[m.k]=v;});
  // Retail: slips marked EFT are credit card payments, so they are added to Credit card
  if(isRetail(dept)&&vals.eft!=null){vals.card=(vals.card||0)+vals.eft;vals.eft=null;}
  const filledKeys=[];
  methodsFor(dept).forEach(m=>{const v=vals[m.k];if(v!=null){doc.lines[m.k].report=v.toFixed(2);filled.push(lbl(m,dept));filledKeys.push(m.k);
    const el=document.getElementById(dept+"-"+m.k+"-report");if(el){el.value=v.toFixed(2);el.style.background="var(--accent-soft)";}}});
  // remember which figures came from which photo, so removing the photo removes them too
  if(photoId&&filledKeys.length){doc.aiFill=doc.aiFill||{};const f={};filledKeys.forEach(k=>{f[k]=doc.lines[k].report;});doc.aiFill[photoId]=f;}
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
          <option value="wholesale">Wholesale cashier</option><option value="retail">Aeroton Retail cashier</option><option value="citydeep">City Deep Retail cashier</option><option value="manager">Manager</option><option value="admin">Administrator</option></select></div>
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
/* ---------- Not banked report: Retail CashGuard counted & retained, not banked, for a date range ---------- */
function renderNotBanked(){
  if(!["manager","admin"].includes(role())){main.innerHTML='<div class="empty-state">Only a manager or the administrator can see this report.</div>';return;}
  const t=todayStr();state.nb=state.nb||{from:t.slice(0,8)+"01",to:t,rows:null,hide:false};const nb=state.nb;const isAdmin=role()==="admin";
  const all=nb.rows||[];const rows=nb.hide?all.filter(r=>!r.done):all;
  const out=all.filter(r=>!r.done).reduce((a,r)=>a+r.retained,0),later=all.filter(r=>r.done).reduce((a,r)=>a+r.retained,0);
  const bankCell=r=>{const box=`<input type="checkbox" class="nbtick" data-i="${all.indexOf(r)}" ${r.done?"checked":""} ${isAdmin?"":"disabled"} aria-label="Banked" style="width:20px;height:20px;cursor:${isAdmin?"pointer":"default"}">`;
    const note=r.done?`<div class="msg" style="font-size:.72rem;line-height:1.2">${esc(r.doneBy)}${r.doneAt?"<br>"+esc(timeStr(r.doneAt)):""}</div>`:r.changed?`<div class="msg err" style="font-size:.75rem">Amount changed after it was ticked. Tick again.</div>`:"";
    return `<td class="nbbank" style="text-align:center">${box}${note}</td>`;};
  const table=nb.loading?'<div class="empty-state">Loading…</div>':nb.err?`<div class="msg err">${esc(nb.err)}</div>`:nb.rows==null?'<div class="empty-state">Choose the dates and tap Show report.</div>':!all.length?`<div class="empty-state">No money was recorded as counted &amp; retained, not banked between ${shortDate(nb.from)} and ${shortDate(nb.to)}.</div>`:
    `<label style="display:inline-flex;gap:8px;align-items:center;margin:4px 0 10px;cursor:pointer"><input type="checkbox" id="nbhide" ${nb.hide?"checked":""}> Hide amounts already banked</label>
    <div class="tbl-wrap"><table><thead><tr><th>Date</th><th>Shop</th><th>Per report<small>CashGuard</small></th><th>In Nedbank<small>Deposited</small></th><th>Not banked<small>Retained / petty cash</small></th><th>Sheet</th><th style="text-align:center">Banked</th></tr></thead>
      <tbody>${rows.map(r=>`<tr class="nbrow${r.done?" nbdone":""}" data-d="${esc(r.date)}" data-shop="${esc(r.shop)}" style="cursor:pointer"><td>${shortDate(r.date)}</td><td>${DEPTS[r.shop]}${r.kind==="petty"?`<div class="msg" style="font-size:.75rem">Petty cash${r.note?" · "+esc(r.note):""}</div>`:""}</td><td class="num">${r.kind==="petty"?"—":R(r.report)}</td><td class="num">${r.kind==="petty"?"—":R(r.nedbank)}</td><td class="num"><b>${R(r.retained)}</b></td><td>${r.signed?`<span class="chip signed" title="Signed by ${esc(r.signedBy)}">Signed</span>`:'<span class="chip draft">Not signed</span>'}</td>${bankCell(r)}</tr>`).join("")||'<tr><td colspan="7" class="msg">Everything in this period has been banked.</td></tr>'}</tbody>
      <tfoot>${[["retail","cg","Aeroton Retail CashGuard"],["retail","petty","Aeroton Retail petty cash"],["citydeep","cg","City Deep Retail CashGuard"]].filter(([sh,k])=>all.some(r=>r.shop===sh&&r.kind===k)).map(([sh,k,l])=>`<tr><td colspan="4" style="font-weight:400">${l} still not banked</td><td class="num">${R(all.filter(r=>r.shop===sh&&r.kind===k&&!r.done).reduce((a,r)=>a+r.retained,0))}</td><td colspan="2"></td></tr>`).join("")}
      ${later?`<tr><td colspan="4" style="font-weight:400">Banked later (ticked)</td><td class="num" style="font-weight:400">${R(later)}</td><td colspan="2"></td></tr>`:""}
      <tr><td colspan="4">Still not banked · ${all.filter(r=>!r.done).length} of ${all.length} line${all.length>1?"s":""}</td><td class="num">${R(out)}</td><td colspan="2"></td></tr></tfoot></table></div>
    <div class="actions" style="margin-top:12px"><button class="btn primary" id="nb-pdf" type="button">Download PDF</button><button class="btn" id="nb-csv" type="button">Download CSV</button><span class="msg" id="nb-msg">Tap a day to open its End of Day.</span></div>`;
  main.innerHTML=`<section class="sheet">
    <div class="sheet-head"><div><div class="eyebrow">CashGuard · Aeroton Retail and City Deep Retail</div><h2>Money not banked</h2></div>${nb.rows&&all.length?`<span class="chip ${out?"draft":"signed"}">Still not banked ${R(out)}</span>`:""}</div>
    <div class="sheet-body">
      <div class="msg">Cash counted from the CashGuard and kept back, not deposited in Nedbank, and Aeroton Retail petty cash, for each day in the period. When the money is banked, the administrator ticks <b>Banked</b> and it is taken off the total.</div>
      <form id="nbform" class="fields" style="grid-template-columns:minmax(0,1fr) minmax(0,1fr) auto;align-items:end" novalidate>
        <div class="field"><label for="nbfrom">From</label><input type="date" id="nbfrom" value="${esc(nb.from)}" max="${t}"></div>
        <div class="field"><label for="nbto">To</label><input type="date" id="nbto" value="${esc(nb.to)}" max="${t}"></div>
        <button class="btn primary" type="submit" id="nbgo">Show report</button>
      </form>
      ${table}
    </div></section>`;
  $("#nbform").addEventListener("submit",e=>{e.preventDefault();let f=$("#nbfrom").value,to=$("#nbto").value;
    if(!/^\d{4}-\d{2}-\d{2}$/.test(f)||!/^\d{4}-\d{2}-\d{2}$/.test(to)){nb.err="Choose both dates.";nb.rows=null;render();return;}
    if(f>to){const x=f;f=to;to=x;}loadNotBanked(f,to);});
  const hd=$("#nbhide");if(hd)hd.addEventListener("change",()=>{nb.hide=hd.checked;render();});
  main.querySelectorAll(".nbbank").forEach(c=>c.addEventListener("click",e=>e.stopPropagation()));
  main.querySelectorAll(".nbtick").forEach(cb=>cb.addEventListener("change",()=>setBanked(all[+cb.dataset.i],cb.checked,cb)));
  main.querySelectorAll(".nbrow").forEach(r=>r.addEventListener("click",()=>{$("#date").value=r.dataset.d;setDate(r.dataset.d);setTab(r.dataset.shop==="citydeep"?"citydeep":"combined");}));
  const pb=$("#nb-pdf");if(pb)pb.addEventListener("click",notBankedPdf);
  const cb=$("#nb-csv");if(cb)cb.addEventListener("click",()=>{
    const cell=c=>{c=String(c==null?"":c);return /[",\n]/.test(c)?'"'+c.replace(/"/g,'""')+'"':c;};
    const lines=[["Money not banked - CashGuard (Aeroton Retail and City Deep Retail)"],["From",nb.from,"To",nb.to],[],["Date","Shop","Type","CashGuard per report","Deposited in Nedbank","Not banked","Details","Signed by","Banked later","Banked ticked by","Ticked at"]]
      .concat(all.map(r=>[r.date,DEPTS[r.shop],r.kind==="petty"?"Petty cash":"CashGuard retained",r.kind==="petty"?"":r.report.toFixed(2),r.kind==="petty"?"":r.nedbank.toFixed(2),r.retained.toFixed(2),r.note,r.signed?r.signedBy:"NOT SIGNED",r.done?"Yes":"No",r.done?r.doneBy:"",r.done?r.doneAt:""]),
        [[],["Still not banked","","","","",out.toFixed(2)],["Banked later (ticked)","","","","",later.toFixed(2)]]);
    const a=document.createElement("a");a.href=URL.createObjectURL(new Blob([lines.map(l=>l.map(cell).join(",")).join("\n")],{type:"text/csv"}));a.download=`Not-banked-${nb.from}-to-${nb.to}.csv`;document.body.appendChild(a);a.click();a.remove();});
}
// Administrator only: mark a retained amount as banked (or undo). Kept in its own record, so signed sheets stay untouched.
const bankedCol=()=>collection(db,"shops",state.key,"banked");
async function setBanked(r,on,cb){if(!r)return;const m=$("#nb-msg");
  if(role()!=="admin"){cb.checked=!on;if(m){m.className="msg err";m.textContent="Only the administrator can tick Banked.";}return;}
  if(!on&&!confirm("Untick Banked for "+DEPTS[r.shop]+(r.kind==="petty"?" petty cash":"")+" on "+shortDate(r.date)+"?\n\n"+R(r.retained)+" will show as not banked again."))return void(cb.checked=true);
  cb.disabled=true;const iso=new Date().toISOString();
  try{await setDoc(fdoc(bankedCol(),r.date+"_"+r.key),{date:r.date,shop:r.key,amount:Math.round(r.retained*100)/100,banked:on,by:state.me.name,at:serverTimestamp(),atIso:iso});
    Object.assign(r,{done:on,changed:false,doneBy:state.me.name,doneAt:iso});render();
    const m2=$("#nb-msg");if(m2){m2.className="msg";m2.textContent=on?`Marked as banked: ${DEPTS[r.shop]}${r.kind==="petty"?" petty cash":""} ${shortDate(r.date)} ${R(r.retained)}.`:"Unticked. The amount shows as not banked again.";}}
  catch(e){console.error("Banked:",e);cb.checked=!on;cb.disabled=false;
    if(m){m.className="msg err";m.textContent=e&&e.code==="permission-denied"?"Not saved: the Firebase rules need updating (publish the new rules).":"Not saved. Check the connection and try again.";}}}
async function loadNotBanked(from,to){const nb=state.nb;nb.from=from;nb.to=to;nb.loading=true;nb.err="";render();
  try{const [snap,bsnap]=await Promise.all([getDocs(query(shopCol(),where("date",">=",from),where("date","<=",to))),
      getDocs(query(bankedCol(),where("date",">=",from),where("date","<=",to))).catch(e=>{console.error("Banked ticks:",e);return {docs:[]};})]);
    const bk={};bsnap.docs.forEach(d=>{bk[d.id]=d.data();});
    // one line per shop per day for CashGuard retained, plus a line for Aeroton Retail petty cash
    const mk=(n,shop,key,kind,report,nedbank,retained)=>{const b=bk[n.date+"_"+key];const ticked=!!(b&&b.banked===true);const same=ticked&&Math.abs(num(b.amount)-retained)<0.005;
      return {date:n.date,shop,key,kind,report,nedbank,retained,signed:n.status==="signed",signedBy:n.signedBy||"",
        done:same,changed:ticked&&!same,doneBy:b?b.by||"":"",doneAt:b?(b.at&&b.at.toDate?b.at.toDate().toISOString():b.atIso||""):"",note:kind==="petty"?(n.pettyNotes||""):""};};
    const out=[];
    snap.docs.map(d=>d.data()).filter(d=>d&&hasSplit(d.dept)&&d.date>=from&&d.date<=to).forEach(d=>{const n=normalize(d,d.date,d.dept);const cg=n.lines.cashguard;
      out.push(mk(n,d.dept,d.dept,"cg",num(cg.report),num(cg.deposited),num(cg.retained)));
      if(d.dept==="retail")out.push(mk(n,"retail","retailpetty","petty",null,null,num(n.lines.petty&&n.lines.petty.deposited)));});
    nb.rows=out.filter(r=>r.retained!==0).sort((a,b)=>a.date.localeCompare(b.date)||a.shop.localeCompare(b.shop)||a.kind.localeCompare(b.kind));}
  catch(e){console.error("Not banked:",e);nb.rows=null;nb.err="The report could not be loaded ("+(e&&(e.code||e.message)||e)+"). Check the connection and try again.";}
  nb.loading=false;if(state.tab==="notbanked")render();}
async function notBankedPdf(){const nb=state.nb,rows=nb.rows||[];const m=$("#nb-msg");if(m)m.textContent="Preparing the PDF…";
  try{const jsPDF=await loadJsPDF();const pdf=new jsPDF({unit:"mm",format:"a4"});const P=s=>String(s).replace(/[   ]/g," ").replace(/−/g,"-");
    const out=rows.filter(r=>!r.done).reduce((a,r)=>a+r.retained,0),later=rows.filter(r=>r.done).reduce((a,r)=>a+r.retained,0);
    let y=18;pdf.setFont("helvetica","bold");pdf.setFontSize(16);pdf.text("Money not banked - CashGuard",14,y);
    pdf.setFont("helvetica","normal");pdf.setFontSize(10);pdf.setTextColor(110);pdf.text(P(`Continental Brands  -  ${longDate(nb.from)} to ${longDate(nb.to)}`),14,y+6);pdf.setTextColor(0);
    y+=16;pdf.setFont("helvetica","bold");pdf.setFontSize(9);
    const C={date:14,shop:42,rep:104,ned:130,nb:156,bank:160};
    pdf.text("Date",C.date,y);pdf.text("Shop",C.shop,y);pdf.text("CashGuard",C.rep,y,{align:"right"});pdf.text("In Nedbank",C.ned,y,{align:"right"});pdf.text("Not banked",C.nb,y,{align:"right"});pdf.text("Banked later",C.bank,y);
    pdf.setDrawColor(200);pdf.line(14,y+2,196,y+2);pdf.setFont("helvetica","normal");pdf.setFontSize(9.5);
    rows.forEach(r=>{y+=7;if(y>280){pdf.addPage();y=20;}if(r.done)pdf.setTextColor(120);
      pdf.text(P(shortDate(r.date)),C.date,y);pdf.text(DEPTS[r.shop]+(r.kind==="petty"?" - petty":""),C.shop,y);if(r.kind!=="petty"){pdf.text(P(R(r.report)),C.rep,y,{align:"right"});pdf.text(P(R(r.nedbank)),C.ned,y,{align:"right"});}
      pdf.setFont("helvetica","bold");pdf.text(P(R(r.retained)),C.nb,y,{align:"right"});pdf.setFont("helvetica","normal");
      pdf.text(P(r.done?("Yes - "+r.doneBy).slice(0,22):"No"),C.bank,y);pdf.setTextColor(0);});
    y+=4;pdf.setDrawColor(0);pdf.setLineWidth(0.5);pdf.line(14,y,196,y);y+=6;
    if(later){pdf.setFont("helvetica","normal");pdf.text("Banked later (ticked)",C.date,y);pdf.text(P(R(later)),C.nb,y,{align:"right"});y+=6;}
    pdf.setFont("helvetica","bold");pdf.text("Still not banked",C.date,y);pdf.text(P(R(out)),C.nb,y,{align:"right"});
    const a=document.createElement("a");a.href=URL.createObjectURL(pdf.output("blob"));a.download=`Not-banked-${nb.from}-to-${nb.to}.pdf`;document.body.appendChild(a);a.click();a.remove();
    if(m)m.textContent="PDF downloaded.";}
  catch(e){console.error(e);if(m){m.className="msg err";m.textContent="The PDF could not be made: "+(e&&e.message||e);}}}
function renderHistory(){
  const by={};state.history.forEach(d=>{if(!d||!d.date)return;(by[d.date]=by[d.date]||{})[d.dept]=d;});
  const dates=Object.keys(by).sort().reverse();
  const cell=(d,dept)=>{if(!d)return `<div><div class="eyebrow">${DEPTS[dept]}</div><span class="chip">Not started</span></div>`;const n=normalize(d,d.date,dept);
    return `<div><div class="eyebrow">${DEPTS[dept]}</div>${chip(statusOf(n))} <span class="num msg">${R(totals(n).deposited)}</span></div>`;};
  main.innerHTML=`<section class="sheet">
    <div class="sheet-head"><div><div class="eyebrow">All cash ups</div><h2>History</h2></div></div>
    <div class="hist">${dates.length?dates.map(d=>{const nz=k=>by[d][k]?normalize(by[d][k],d,k):null;const w=nz("wholesale"),r=nz("retail"),mg=nz("manager"),c=nz("citydeep"),cm=nz("cdmanager");
      const sh=[w,r,c].filter(Boolean);const tot=sh.reduce((a,x)=>a+totals(x).deposited,0),vr=sh.reduce((a,x)=>a+totals(x).variance,0);const di=dayInfo(d,w,r,mg,c,cm);
      const withCD=cdOn(d)||!!c;
      return `<button class="hrow${withCD?" cd":""}" data-d="${esc(d)}"><div><div class="d">${shortDate(d)}</div><span class="chip ${di.cls}" style="margin-top:4px">${di.kind==="done"?"Closed on time":di.kind==="late"?"Closed late":di.kind==="overdue"?"Overdue":di.kind==="sunday"?"Sunday":"Open"}</span></div>${cell(by[d].wholesale,"wholesale")}${cell(by[d].retail,"retail")}${withCD?cell(by[d].citydeep,"citydeep"):""}<div class="r"><div class="num"><b>${R(tot)}</b></div><div class="num msg ${vcls(vr)}">${RV(vr)}</div></div></button>`;}).join("")
      :`<div class="empty-state">No cash ups yet. Open a shop's tab for today and enter the report and deposited amounts. Each day will appear here.</div>`}</div></section>`;
  main.querySelectorAll(".hrow").forEach(b=>b.addEventListener("click",()=>{$("#date").value=b.dataset.d;setDate(b.dataset.d);setTab("combined");}));
}

window.addEventListener("pagehide",flushAll);
document.addEventListener("visibilitychange",()=>{if(document.visibilityState==="hidden")flushAll();});
setInterval(()=>{if(state.ready&&state.tab!=="users"&&!main.contains(document.activeElement)&&!document.getElementById("pad"))render();},60000); // keep the deadline countdown current
