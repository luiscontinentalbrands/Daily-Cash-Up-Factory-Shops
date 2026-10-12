import { firebaseConfig } from "./firebase-config.js";
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getFirestore, doc as fdoc, getDocs, setDoc, addDoc, collection, query, where, orderBy, limit, onSnapshot, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

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
if(configured){app=initializeApp(firebaseConfig);db=getFirestore(app);}

const state={date:todayStr(),tab:"wholesale",docs:{wholesale:null,retail:null,manager:null},history:[],pending:{},key:null,ready:false};
const local={};let daySub=null,histSub=null,timers={};

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
    <div class="msg">Open the setup link your manager sent you on this device, or type the shop access code below. You only do this once per device.</div>
    <div class="field"><label for="keyin">Shop access code</label><input id="keyin" autocomplete="off" autocapitalize="off" spellcheck="false"></div>
    <button class="btn primary" type="submit" id="keybtn">Set up this device</button>
    <div class="msg ${msg?"err":""}" id="keymsg">${esc(msg||"")}</div>
  </form>`;
  $("#keyform").addEventListener("submit",e=>{e.preventDefault();const v=$("#keyin").value.trim();
    if(!KEY_RE.test(v)){const m=$("#keymsg");m.className="msg err";m.textContent="That code is not valid. Check it and try again.";return;}
    $("#keybtn").disabled=true;checkKey(v);});
}
async function checkKey(k){
  state.key=k;main.innerHTML=`<div class="empty-state">Connecting…</div>`;
  try{await getDocs(query(collection(db,"shops",k,"cashups"),limit(1)));
    saveKey(k);startApp();}
  catch(e){state.key=null;
    if(e&&e.code==="permission-denied"){forgetKey();showSetup("This device's access code is not accepted. Ask your manager for the current setup link.");}
    else showSetup("Could not reach the database. Check the internet connection and try again.");}
}
function deviceBar(){const w=$("#who");w.hidden=false;
  w.innerHTML=`<span>This device is set up</span><button id="forget" type="button">Remove from this device</button>`;
  let armed=false;$("#forget").addEventListener("click",()=>{const b=$("#forget");
    if(!armed){armed=true;b.textContent="Tap again to remove";setTimeout(()=>{armed=false;if(b.isConnected)b.textContent="Remove from this device";},4000);return;}
    flushAll();forgetKey();stopSubs();state.key=null;showSetup("Access removed from this device.");});}

/* ---------- app start ---------- */
function startApp(){
  $("#tabs").hidden=false;$("#datebox").hidden=false;deviceBar();state.ready=true;
  $("#foot").textContent="Live sync active · shared by all cashiers";
  try{const t=localStorage.getItem("cu_tab");if(t)state.tab=t;}catch(e){}
  state.date=todayStr();$("#date").value=state.date;
  Object.keys(local).forEach(k=>delete local[k]);
  subscribeDay();subscribeHistory();setTab(state.tab);
}
$("#date").addEventListener("change",e=>{if(e.target.value)setDate(e.target.value);});
$("#today").addEventListener("click",()=>{$("#date").value=todayStr();setDate(todayStr());});
document.querySelectorAll("nav.tabs button").forEach(b=>b.addEventListener("click",()=>setTab(b.dataset.tab)));
function setTab(t){state.tab=t;try{localStorage.setItem("cu_tab",t);}catch(e){}
  document.querySelectorAll("nav.tabs button").forEach(b=>b.setAttribute("aria-selected",String(b.dataset.tab===t)));render();}
function setDate(d){flushAll();state.date=d;state.docs={wholesale:null,retail:null,manager:null};delete local.wholesale;delete local.retail;delete local.manager;subscribeDay();render();}
function stopSubs(){if(daySub){daySub();daySub=null;}if(histSub){histSub();histSub=null;}}

function canReopen(dept){return dept==="manager"||current("manager").status!=="signed";}
function current(dept){if(!local[dept])local[dept]=normalize(state.docs[dept],state.date,dept);return local[dept];}
function statusOf(doc){if(!doc)return "new";return doc.status==="signed"?"signed":(doc.status==="draft"?"draft":"new");}
function chip(st){return st==="signed"?'<span class="chip signed">Signed off</span>':st==="draft"?'<span class="chip draft">In progress</span>':'<span class="chip">Not started</span>';}
function updateDots(){["wholesale","retail"].forEach(d=>{const st=statusOf(local[d]||state.docs[d]);$("#dot-"+d).className="dot "+(st==="new"?"":st);});}

/* ---------- persistence ---------- */
function idOf(dept,date){return (date||state.date)+"_"+dept;}
function scheduleSave(dept){const doc=local[dept];if(doc.status==="new")doc.status="draft";
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
  try{await setDoc(shopDoc(idOf(dept,doc.date)),payload(doc,!!opts.signing,opts.action==="reopened"));
    state.pending[dept]=false;setSaved(dept,"Saved for everyone · "+timeStr(new Date().toISOString()));
    if(opts.action){try{await addDoc(collection(db,"shops",state.key,"cashups",idOf(dept,doc.date),"history"),{name:String(opts.by||doc.signedBy||"").slice(0,80),action:opts.action,at:serverTimestamp(),totals:dept==="manager"?null:totals(doc)});}catch(e){}}
    return true;}
  catch(e){state.pending[dept]=false;
    setSaved(dept,e&&e.code==="permission-denied"?"Not saved: this change is not allowed (for example, the sheet was signed or the day was closed).":"Could not save. Check your connection and try again.",true);
    return false;}}
function setSaved(dept,t,err){const el=document.getElementById("saved-"+dept)||document.getElementById("sign-msg");if(el){el.textContent=t;el.className=(el.id==="sign-msg"?"msg":"saved")+(err?" msg err":"");}}

function subscribeDay(){if(daySub){daySub();daySub=null;}
  const date=state.date;
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
function render(){if(!state.ready)return;updateDots();
  if(state.tab==="wholesale"||state.tab==="retail")renderDept(state.tab);
  else if(state.tab==="combined")renderCombined();else renderHistory();}

function banner(di){if(di.kind==="sunday")return "";
  return `<div class="banner ${di.kind==="done"?"ok":di.kind==="overdue"?"bad":"wait"}" style="font-weight:500">${di.kind==="overdue"?"Past the 7 pm deadline. Missing: "+di.missing.join(", ")+".":di.kind==="open"?di.label+". Wholesale, Retail and the Manager must all sign.":di.label+"."}</div>`;}

function renderDept(dept){
  const doc=current(dept),signed=doc.status==="signed",editable=!signed,dis=editable?"":"disabled";
  const t=totals(doc);
  const rows=METHODS.map(m=>{const ln=doc.lines[m.k];const v=num(ln.deposited)-num(ln.report);
    return `<tr><td>${m.l}</td>
      <td class="inp"><input id="${dept}-${m.k}-report" data-m="${m.k}" data-f="report" inputmode="decimal" placeholder="0.00" value="${esc(ln.report)}" ${dis} aria-label="${m.l} per report"></td>
      <td class="inp"><input id="${dept}-${m.k}-deposited" data-m="${m.k}" data-f="deposited" inputmode="decimal" placeholder="0.00" value="${esc(ln.deposited)}" ${dis} aria-label="${m.l} deposited"></td>
      <td class="num ${vcls(v)}" id="v-${m.k}">${RV(v)}</td></tr>`;}).join("");
  const di=dayInfo(state.date,current("wholesale"),current("retail"),current("manager"));
  main.innerHTML=`${banner(di)}
  <section class="sheet">
    <div class="sheet-head"><div><div class="eyebrow">${DEPTS[dept]} department</div><h2>${longDate(state.date)}</h2></div>${chip(statusOf(doc))}</div>
    <div class="sheet-body">
      <div class="fields">
        <div class="field"><label>Date</label><div class="static">${shortDate(state.date)}</div></div>
        <div class="field"><label for="${dept}-cashier">Person cashing up</label><input id="${dept}-cashier" value="${esc(doc.cashier)}" placeholder="Full name" ${dis} maxlength="80" autocomplete="name"></div>
        <div class="field"><label>Department</label><div class="static">${DEPTS[dept]}</div></div>
      </div>
      <div class="tbl-wrap"><table>
        <thead><tr><th>Payment type</th><th>Per report<small>Till / Z-report</small></th><th>Deposited<small>Actual counted</small></th><th>Variance<small>Deposited − report</small></th></tr></thead>
        <tbody>${rows}</tbody>
        <tfoot><tr><td>Total</td><td class="num" id="t-report">${R(t.report)}</td><td class="num" id="t-dep">${R(t.deposited)}</td><td class="num ${vcls(t.variance)}" id="t-var">${RV(t.variance)}</td></tr></tfoot>
      </table></div>
      <div class="dmg">
        <div class="field"><label for="${dept}-damaged">Damaged bank notes &amp; coins (R)</label><input id="${dept}-damaged" class="num" inputmode="decimal" placeholder="0.00" value="${esc(doc.damaged)}" ${dis} style="text-align:right"></div>
        <div class="field"><label for="${dept}-damagedNotes">Damaged details</label><input id="${dept}-damagedNotes" value="${esc(doc.damagedNotes)}" placeholder="e.g. 1 × R100 torn, 3 × R5 coins bent" ${dis} maxlength="300"></div>
      </div>
      <div class="field"><label for="${dept}-notes">Notes (explain any variance)</label><textarea id="${dept}-notes" ${dis} maxlength="1000" placeholder="e.g. R50 short on cash, float counted twice">${esc(doc.notes)}</textarea></div>
      <div class="saved" id="saved-${dept}">${doc.updatedAt?"Last saved "+timeStr(doc.updatedAt):(editable?"Saves automatically as you type":"")}</div>
    </div>
  </section>
  <section class="sheet">
    <div class="sheet-head"><div><div class="eyebrow">Sign-off</div><h2>${DEPTS[dept]} signature</h2></div></div>
    <div class="sheet-body">${signed?signedBlock(doc,dept):signBlock(doc,dept)}</div>
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
    <div class="field"><label for="signer">Signed by (full name)</label><input id="signer" value="${esc(dept==="manager"?"":doc.cashier)}" placeholder="Full name" maxlength="80" autocomplete="name"></div>
    <div class="actions"><button class="btn" id="clear" type="button">Clear</button><button class="btn primary" id="signbtn" type="button">Sign &amp; submit</button></div>
    <div class="msg" id="sign-msg"></div>
  </div></div>`;}

function patchInputs(dept){const doc=local[dept];
  METHODS.forEach(m=>["report","deposited"].forEach(f=>{const el=document.getElementById(dept+"-"+m.k+"-"+f);if(el&&el!==document.activeElement)el.value=doc.lines[m.k][f];}));
  [["cashier","cashier"],["notes","notes"],["damaged","damaged"],["damagedNotes","damagedNotes"]].forEach(([id,k])=>{const el=document.getElementById(dept+"-"+id);if(el&&el!==document.activeElement)el.value=doc[k];});
  recalc(dept);}
function recalc(dept){const doc=local[dept];
  METHODS.forEach(m=>{const v=num(doc.lines[m.k].deposited)-num(doc.lines[m.k].report);const el=document.getElementById("v-"+m.k);if(el){el.textContent=RV(v);el.className="num "+vcls(v);}});
  const t=totals(doc),a=$("#t-report"),b=$("#t-dep"),c=$("#t-var");
  if(a){a.textContent=R(t.report);b.textContent=R(t.deposited);c.textContent=RV(t.variance);c.className="num "+vcls(t.variance);}}
const money=v=>v.replace(/[^0-9.]/g,"").replace(/(\..*)\./g,"$1").slice(0,12);

function bindDept(dept){const doc=local[dept];
  main.querySelectorAll("td.inp input").forEach(inp=>{
    inp.addEventListener("input",()=>{const c=money(inp.value);if(c!==inp.value)inp.value=c;doc.lines[inp.dataset.m][inp.dataset.f]=inp.value;recalc(dept);scheduleSave(dept);});
    inp.addEventListener("blur",()=>{if(inp.value!==""){const v=num(inp.value).toFixed(2);inp.value=v;doc.lines[inp.dataset.m][inp.dataset.f]=v;scheduleSave(dept);}});});
  const cs=document.getElementById(dept+"-cashier");if(cs)cs.addEventListener("input",()=>{doc.cashier=cs.value;const sg=$("#signer");if(sg&&!sg.dataset.touched)sg.value=cs.value;scheduleSave(dept);});
  const n=document.getElementById(dept+"-notes");if(n)n.addEventListener("input",()=>{doc.notes=n.value;scheduleSave(dept);});
  const dm=document.getElementById(dept+"-damaged");if(dm){dm.addEventListener("input",()=>{const c=money(dm.value);if(c!==dm.value)dm.value=c;doc.damaged=dm.value;scheduleSave(dept);});
    dm.addEventListener("blur",()=>{if(dm.value!==""){dm.value=num(dm.value).toFixed(2);doc.damaged=dm.value;scheduleSave(dept);}});}
  const dn=document.getElementById(dept+"-damagedNotes");if(dn)dn.addEventListener("input",()=>{doc.damagedNotes=dn.value;scheduleSave(dept);});
  const ro=$("#reopen");if(ro){let armed=false;ro.addEventListener("click",async()=>{
    if(!armed){armed=true;ro.textContent="Tap again to reopen";$("#reopen-msg").textContent="The signature will be removed.";setTimeout(()=>{armed=false;if(ro.isConnected){ro.textContent="Reopen to correct";$("#reopen-msg").textContent="";}},4000);return;}
    ro.disabled=true;
    const M=current("manager");
    if(dept!=="manager"&&M.status==="signed"){
      Object.assign(M,{status:"draft",signature:"",signedBy:"",signedAt:""});state.pending.manager=true;
      if(!await save("manager",{action:"reopened",by:"reopened from "+DEPTS[dept]+" sheet"})){ro.disabled=false;$("#reopen-msg").textContent="Could not reopen the day. Try again.";return;}}
    Object.assign(doc,{status:"draft",signature:"",signedBy:"",signedAt:""});clearTimeout(timers[dept]);state.pending[dept]=true;
    await save(dept,{action:"reopened",by:doc.cashier||""});render();});}
  const pad=$("#pad");if(pad)bindPad(pad,dept);
}
function bindPad(cv,dept){const ctx=cv.getContext("2d");let drawing=false,inked=false,last=null;
  ctx.lineWidth=3.2;ctx.lineCap="round";ctx.lineJoin="round";ctx.strokeStyle="#1f2a44";ctx.fillStyle="#1f2a44";
  const pt=e=>{const r=cv.getBoundingClientRect();return {x:(e.clientX-r.left)*cv.width/r.width,y:(e.clientY-r.top)*cv.height/r.height};};
  cv.addEventListener("pointerdown",e=>{drawing=true;last=pt(e);cv.setPointerCapture(e.pointerId);ctx.beginPath();ctx.arc(last.x,last.y,1.5,0,Math.PI*2);ctx.fill();inked=true;});
  cv.addEventListener("pointermove",e=>{if(!drawing)return;const p=pt(e);ctx.beginPath();ctx.moveTo(last.x,last.y);ctx.lineTo(p.x,p.y);ctx.stroke();last=p;});
  const end=()=>{drawing=false;};cv.addEventListener("pointerup",end);cv.addEventListener("pointercancel",end);
  const sg=$("#signer");if(sg)sg.addEventListener("input",()=>{sg.dataset.touched="1";});
  $("#clear").addEventListener("click",()=>{ctx.clearRect(0,0,cv.width,cv.height);inked=false;$("#sign-msg").textContent="";});
  $("#signbtn").addEventListener("click",async()=>{const doc=local[dept];const msg=$("#sign-msg");msg.className="msg err";
    if(dept==="manager"){const W=current("wholesale"),Rt=current("retail");
      if(!(W.status==="signed"&&Rt.status==="signed")){msg.textContent="Wholesale and Retail must both sign first.";return;}
      const nm=($("#signer").value||"").trim().toLowerCase();
      if(nm&&(nm===String(W.signedBy).trim().toLowerCase()||nm===String(Rt.signedBy).trim().toLowerCase())){msg.textContent="The manager sign-off must be done by a different person from the cashiers who signed.";return;}}
    else{const t=totals(doc);if(t.report===0&&t.deposited===0){msg.textContent="Enter the report and deposited amounts before signing.";return;}}
    const who=($("#signer").value||"").trim();
    if(who.length<3){msg.textContent="Type the full name of the person signing.";$("#signer").focus();return;}
    if(!inked){msg.textContent="Draw the signature in the box first.";return;}
    const out=document.createElement("canvas");out.width=600;out.height=200;const o=out.getContext("2d");o.fillStyle="#fff";o.fillRect(0,0,600,200);o.drawImage(cv,0,0,600,200);
    const before=clone(doc);
    Object.assign(doc,{signature:out.toDataURL("image/png"),signedBy:who,signedAt:new Date().toISOString(),status:"signed"});
    if(dept!=="manager"&&!doc.cashier)doc.cashier=who;
    clearTimeout(timers[dept]);state.pending[dept]=true;$("#signbtn").disabled=true;msg.className="msg";msg.textContent="Signing…";
    const ok=await save(dept,{signing:true,action:"signed",by:who});
    if(!ok){local[dept]=before;render();const m2=$("#sign-msg");if(m2){m2.className="msg err";m2.textContent="Not signed. Check the connection and try again.";}return;}
    render();});
}

function renderCombined(){
  const W=current("wholesale"),Rt=current("retail"),M=current("manager");const tw=totals(W),tr=totals(Rt);
  const both=W.status==="signed"&&Rt.status==="signed";const info=dayInfo(state.date,W,Rt,M);
  const dmgT=num(W.damaged)+num(Rt.damaged);
  const mgrBlock=M.status==="signed"?signedBlock(M,"manager"):both?signBlock(M,"manager"):`<div class="msg">You can sign here once Wholesale and Retail have both signed. Still waiting for: ${[W.status!=="signed"?"Wholesale":"",Rt.status!=="signed"?"Retail":""].filter(Boolean).join(" and ")}.</div>`;
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
      <div class="sigs">${sig(W,"wholesale")}${sig(Rt,"retail")}</div>
      <div class="actions"><button class="btn" id="csv">Download day as CSV</button><span class="msg" id="csv-msg"></span></div>
    </div>
  </section>
  <section class="sheet">
    <div class="sheet-head"><div><div class="eyebrow">End-of-day sign-off · due by 7 pm</div><h2>Manager signature</h2></div>${M.status==="signed"?'<span class="chip signed">Signed off</span>':'<span class="chip">Not signed</span>'}</div>
    <div class="sheet-body">${mgrBlock}</div>
  </section>`;
  local.manager=M;bindDept("manager");
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
setInterval(()=>{if(state.ready&&!main.contains(document.activeElement)&&!document.getElementById("pad"))render();},60000); // keep the deadline countdown current
