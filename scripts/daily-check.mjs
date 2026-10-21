// Daily cash up check, run by GitHub Actions (see .github/workflows/cashup-daily-check.yml).
//   node daily-check.mjs seven   → 19:05: alert Ulla if a signature is missing, send Martie the report
//   node daily-check.mjs nine    → 21:00: if the day was incomplete at 7 pm, send Martie the final report
//                                  once it is complete, otherwise remind Ulla it is still missing.
// Secrets come from GitHub repository secrets; nothing secret is stored in this file.

import admin from "firebase-admin";
import nodemailer from "nodemailer";
import { jsPDF } from "jspdf";
import { buildReportPdf, reportFileName } from "../report-pdf.js";

const MODE = (process.argv[2] || "seven").toLowerCase();
const TZ = "Africa/Johannesburg";
const ALERT_TO = process.env.ALERT_TO || "ulla@tastytreats.co.za";
const REPORT_TO = process.env.REPORT_TO || "martie@tastytreats.co.za";

const METHODS = [
  ["cash", "Cash / Coins (Retail shops)"], ["cashguard", "CashGuard"], ["card", "Credit card"],
  ["eft", "EFT"], ["shop2shop", "Shop2Shop"], ["snapscan", "SnapScan"],
];

function need(name) {
  const v = process.env[name];
  if (!v) { console.error(`Missing secret ${name}. Add it under GitHub → Settings → Secrets and variables → Actions.`); process.exit(1); }
  return v;
}

admin.initializeApp({ credential: admin.credential.cert(JSON.parse(need("FIREBASE_SERVICE_ACCOUNT"))) });
const db = admin.firestore();
const SHOP_KEY = need("SHOP_KEY");
if (!/^[A-Za-z0-9]{16,64}$/.test(SHOP_KEY)) { console.error("SHOP_KEY is not valid."); process.exit(1); }
const base = `shops/${SHOP_KEY}`;

const mailer = nodemailer.createTransport({
  host: process.env.SMTP_HOST || "smtp.gmail.com",
  port: Number(process.env.SMTP_PORT || 465),
  secure: Number(process.env.SMTP_PORT || 465) === 465,
  auth: { user: need("SMTP_USER"), pass: need("SMTP_PASS") },
});
const FROM = process.env.MAIL_FROM || `Factory Shop Cash Up <${process.env.SMTP_USER}>`;

// ---------- dates ----------
const ymd = d => new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
const hourSAST = Number(new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", hourCycle: "h23" }).format(new Date()));
// If a delayed 9 pm run only starts after midnight, it still checks the previous trading day.
const today = hourSAST < 6 ? ymd(new Date(Date.now() - 12 * 3600 * 1000)) : ymd(new Date());
const DATE = process.env.CASHUP_DATE || today;
if (!/^\d{4}-\d{2}-\d{2}$/.test(DATE)) { console.error("Date must be YYYY-MM-DD."); process.exit(1); }
const DEADLINE = new Date(`${DATE}T19:00:00+02:00`);
const [Y, M, D] = DATE.split("-").map(Number);
const dayName = new Date(Date.UTC(Y, M - 1, D, 12)).toLocaleDateString("en-ZA", { timeZone: "UTC", weekday: "short" });
const niceDate = new Date(Date.UTC(Y, M - 1, D, 12)).toLocaleDateString("en-ZA", { timeZone: "UTC", weekday: "short", day: "numeric", month: "short", year: "numeric" });
if (dayName.startsWith("Sun")) { console.log(`${DATE} is a Sunday, not a trading day. Nothing to do.`); process.exit(0); }

// ---------- helpers ----------
const num = s => { const n = parseFloat(String(s ?? "").replace(/[^0-9.\-]/g, "")); return isFinite(n) ? n : 0; };
const fmt = new Intl.NumberFormat("en-ZA", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const R = v => "R " + fmt.format(v || 0);
const RV = v => { const a = Math.round(v * 100) / 100; return a === 0 ? "R 0.00" : (a > 0 ? "+" : "−") + "R " + fmt.format(Math.abs(a)); };
const vcolor = v => { const a = Math.round(v * 100) / 100; return a === 0 ? "#2f6b3a" : a > 0 ? "#9a6a12" : "#b03a2a"; };
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const when = doc => {
  const t = doc?.signedAtServer?.toDate ? doc.signedAtServer.toDate() : (doc?.signedAt ? new Date(doc.signedAt) : null);
  return t ? t.toLocaleString("en-ZA", { timeZone: TZ, day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "";
};
const signedTime = doc => doc?.signedAtServer?.toDate ? doc.signedAtServer.toDate() : (doc?.signedAt ? new Date(doc.signedAt) : null);

// ---------- read the day ----------
// City Deep (a separate shop with its own manager sign-off) is required from this date; keep in step with CD_START in app.js
const CD_START = "2026-10-20";
const ids = ["wholesale", "retail", "manager", "citydeep", "cdmanager"];
const snaps = await Promise.all(ids.map(d => db.doc(`${base}/cashups/${DATE}_${d}`).get()));
const [W, Rt, Mg, Cd0, Cm0] = snaps.map(s => (s.exists ? s.data() : null));
const withCD = DATE >= CD_START || !!Cd0;
const Cd = withCD ? Cd0 : null, Cm = withCD ? Cm0 : null;
const signedNow = d => !!d && d.status === "signed";
// The 7 pm check judges the day as it stood at 19:00, even if GitHub starts the job late.
const signedByDeadline = d => signedNow(d) && (signedTime(d)?.getTime() ?? Infinity) <= DEADLINE.getTime();
const signed = MODE === "seven" ? signedByDeadline : signedNow;
const missing = [];
if (!signed(W)) missing.push("Wholesale");
if (!signed(Rt)) missing.push("Aeroton Retail");
if (!signed(Mg)) missing.push("Manager");
if (withCD && !signed(Cd)) missing.push("City Deep Retail");
const complete = missing.length === 0;
const nothing = !W && !Rt && !Mg && !Cd && !Cm;

const logRef = db.doc(`${base}/emaillog/${DATE}`);
const logSnap = await logRef.get();
const log = logSnap.exists ? logSnap.data() : {};

// ---------- build report ----------
function line(doc, k, f) { return num(doc?.lines?.[k]?.[f]); }
// Lines per shop: Retail has no EFT or Shop2Shop; Retail and City Deep split CashGuard (Nedbank + counted & retained, not banked)
const SHOP_LINES = { wholesale: null, retail: ["cash", "cashguard", "card", "snapscan"], citydeep: ["cash", "cashguard", "card", "snapscan"] };
const hasLine = (shop, k) => !SHOP_LINES[shop] || SHOP_LINES[shop].includes(k);
const splitShop = shop => shop === "retail" || shop === "citydeep";
function reportHtml(title, note) {
  const shops = [["Wholesale", W, "wholesale"], ["Aeroton Retail", Rt, "retail"]];
  if (withCD) shops.push(["City Deep Retail", Cd, "citydeep"]);
  const td = 'style="padding:6px 8px;text-align:right;border-bottom:1px solid #eee"';
  const tot = shops.map(() => [0, 0]);
  const rows = METHODS.map(([k, l]) => {
    let r = 0, dd = 0;
    const cells = shops.map(([, doc, shop], i) => {
      if (!hasLine(shop, k)) return `<td ${td}>—</td><td ${td}>—</td>`;
      const a = line(doc, k, "report"), b = line(doc, k, "deposited") + (splitShop(shop) ? line(doc, k, "retained") : 0);
      r += a; dd += b; tot[i][0] += a; tot[i][1] += b;
      return `<td ${td}>${R(a)}</td><td ${td}>${R(b)}</td>`;
    }).join("");
    const v = dd - r;
    return `<tr><td style="padding:6px 8px;border-bottom:1px solid #eee">${l}</td>${cells}<td ${td}><b>${R(r)}</b></td><td ${td}><b>${R(dd)}</b></td><td style="padding:6px 8px;text-align:right;border-bottom:1px solid #eee;color:${vcolor(v)}"><b>${RV(v)}</b></td></tr>`;
  }).join("");
  const gr = tot.reduce((a, t) => a + t[0], 0), gd = tot.reduce((a, t) => a + t[1], 0), gv = gd - gr;
  const th = 'style="padding:6px 8px;text-align:right"', tf = 'style="padding:8px;text-align:right"';
  const sigRow = (label, doc) => `<tr><td style="padding:4px 10px">${label}</td><td style="padding:4px 10px">${signed(doc) ? `${esc(doc.signedBy)} · ${when(doc)}` : `<span style="color:#b03a2a"><b>NOT SIGNED</b></span>`}</td></tr>`;
  const each = f => shops.map(([l, doc]) => `${l} ${f(doc)}`).join(" · ");
  return `<div style="font-family:Arial,Helvetica,sans-serif;color:#1f1c18;max-width:1000px">
  <h2 style="margin:0 0 4px">${esc(title)}</h2>
  <div style="color:#7a7268;margin-bottom:14px">Continental Brands · ${withCD ? "Aeroton and City Deep" : "Daily Factory Shop Cash Up"} · ${esc(niceDate)}</div>
  ${note ? `<div style="background:#f8e4e0;color:#b03a2a;padding:10px 14px;border-radius:8px;margin-bottom:14px"><b>${note}</b></div>` : ""}
  <table style="border-collapse:collapse;font-size:13px;width:100%">
    <thead><tr style="background:#f7f4ef"><th style="padding:6px 8px;text-align:left">Payment type</th>
      ${shops.map(([l]) => `<th ${th}>${l} report</th><th ${th}>${l} deposited</th>`).join("")}
      <th ${th}>${withCD ? "All shops" : "Combined"} report</th><th ${th}>${withCD ? "All shops" : "Combined"} deposited</th><th ${th}>Variance</th></tr></thead>
    <tbody>${rows}</tbody>
    <tfoot><tr style="border-top:2px solid #1f1c18"><td style="padding:8px"><b>Total</b></td>
      ${tot.map(t => `<td ${tf}><b>${R(t[0])}</b></td><td ${tf}><b>${R(t[1])}</b></td>`).join("")}
      <td ${tf}><b>${R(gr)}</b></td><td ${tf}><b>${R(gd)}</b></td><td style="padding:8px;text-align:right;color:${vcolor(gv)}"><b>${RV(gv)}</b></td></tr></tfoot>
  </table>
  ${withCD ? `<p style="margin:14px 0 4px"><b>Variance by shop:</b> Aeroton ${RV((tot[0][1] + tot[1][1]) - (tot[0][0] + tot[1][0]))} · City Deep Retail ${RV(tot[2][1] - tot[2][0])} · <b>All shops ${RV(gv)}</b></p>` : ""}
  ${shops.filter(([, , sh]) => splitShop(sh)).map(([l, doc]) => `<p style="margin:4px 0"><b>${l} CashGuard:</b> deposited in Nedbank ${R(line(doc, "cashguard", "deposited"))} · counted &amp; retained, not banked <b>${R(line(doc, "cashguard", "retained"))}</b></p>`).join("")}
  <p style="margin:4px 0"><b>Damaged bank notes &amp; coins:</b> ${each(d => R(num(d?.damaged)) + (d?.damagedNotes ? " (" + esc(d.damagedNotes) + ")" : ""))} · <b>Total ${R(shops.reduce((a, [, d]) => a + num(d?.damaged), 0))}</b></p>
  <p style="margin:4px 0"><b>Cashed up by:</b> ${each(d => esc(d?.cashier || "—"))}</p>
  ${shops.map(([l, d]) => d?.notes ? `<p style="margin:4px 0"><b>${l} notes:</b> ${esc(d.notes)}</p>` : "").join("")}
  <table style="margin-top:10px;font-size:14px"><tbody>${sigRow("Wholesale signature", W)}${sigRow("Aeroton Retail signature", Rt)}${withCD ? sigRow("City Deep Retail signature", Cd) : ""}${sigRow("Manager signature", Mg)}</tbody></table>
  <p style="color:#7a7268;font-size:12px;margin-top:18px">Variance = deposited − report. Negative (red) means short; positive (amber) means over. Signature times are taken from the server clock (SAST).</p>
  </div>`;
}
function alertHtml(lead) {
  const done = [["Wholesale", W], ["Aeroton Retail", Rt], ...(withCD ? [["City Deep Retail", Cd]] : []), ["Manager", Mg]].filter(([, d]) => signed(d)).map(([l, d]) => `<li>${l}: ${esc(d.signedBy)} · ${when(d)}</li>`).join("");
  return `<div style="font-family:Arial,Helvetica,sans-serif;color:#1f1c18">
  <p>${lead}</p>
  <p><b>Missing signature${missing.length > 1 ? "s" : ""}:</b> ${missing.join(", ")}</p>
  ${done ? `<p><b>Already signed:</b></p><ul>${done}</ul>` : "<p>Nothing has been signed yet.</p>"}
  <p style="color:#7a7268">The cash up must be completed and signed by Wholesale, Aeroton Retail${withCD ? ", City Deep Retail" : ""} and the Manager by 7 pm every trading day (Monday to Saturday).</p></div>`;
}
// ---------- PDF attachment (same layout as the app's "Download PDF") ----------
async function reportPdf(status) {
  const iso = doc => doc ? Object.assign({}, doc, { signedAt: signedTime(doc)?.toISOString() || "" }) : null;
  let photos = [];
  try {
    const ps = await db.collection(`${base}/photos`).where("date", "==", DATE).get();
    photos = ps.docs.map(x => x.data()).filter(p => p.removed !== true)
      .sort((a, b) => String(a.dept).localeCompare(String(b.dept)) || String(a.takenAt || "").localeCompare(String(b.takenAt || "")));
  } catch (e) { console.error("Photos could not be read:", e.message); }
  const pdf = buildReportPdf(jsPDF, { date: DATE, niceDate, W: iso(W), Rt: iso(Rt), M: iso(Mg), C: withCD ? (iso(Cd) || { status: "new" }) : null, status, photos });
  return { filename: reportFileName(DATE), content: Buffer.from(pdf.output("arraybuffer")), contentType: "application/pdf" };
}
async function send(to, subject, html, pdfStatus) {
  const attachments = [];
  if (pdfStatus) { try { attachments.push(await reportPdf(pdfStatus)); } catch (e) { console.error("PDF could not be made:", e.message); } }
  await mailer.sendMail({ from: FROM, to, subject, html, attachments });
  console.log(`Sent "${subject}" to ${to}${attachments.length ? " with PDF" : ""}`);
}

// ---------- run ----------
const now = new Date().toISOString();
if (MODE === "seven") {
  if (!complete) {
    await send(ALERT_TO, `Cash up signatures missing – ${niceDate}`, alertHtml(`The factory shop cash up for <b>${esc(niceDate)}</b> was not fully signed by the 7 pm deadline.`));
  }
  if (nothing) {
    await send(REPORT_TO, `INCOMPLETE – Factory Shop Cash Up – ${niceDate}`, `<div style="font-family:Arial,Helvetica,sans-serif"><p>No cash up was captured for <b>${esc(niceDate)}</b> by 7 pm.</p><p>A final report will follow if it is completed tonight.</p></div>`);
  } else {
    await send(REPORT_TO, `${complete ? "" : "INCOMPLETE – "}Factory Shop Cash Up – ${niceDate}`,
      reportHtml("Factory Shop Cash Up", complete ? "" : `Incomplete at 7 pm: missing ${missing.join(", ")}. A final report follows once it is complete.`),
      complete ? "Completed on time" : `INCOMPLETE at 7 pm - missing ${missing.join(", ")}`);
  }
  await logRef.set({ date: DATE, sentAt: now, complete, missing, ullaAlerted: !complete, martieFinalSent: complete }, { merge: true });
} else if (MODE === "nine") {
  if (log.martieFinalSent) { console.log("Complete report already sent at 7 pm. Nothing to do."); process.exit(0); }
  if (complete) {
    const last = Math.max(...[W, Rt, Mg, Cd].map(d => signedTime(d)?.getTime() || 0));
    const lastStr = new Date(last).toLocaleString("en-ZA", { timeZone: TZ, hour: "2-digit", minute: "2-digit" });
    const late = last > DEADLINE.getTime();
    const note = log.sentAt
      ? `This replaces the incomplete 7 pm report.${late ? ` The last signature was at ${lastStr}, after the 7 pm deadline.` : ""}`
      : (late ? `Signed late: the last signature was at ${lastStr}, after the 7 pm deadline.` : "");
    let html = reportHtml(log.sentAt ? "Factory Shop Cash Up – final" : "Factory Shop Cash Up", note);
    html = html.replace("background:#f8e4e0;color:#b03a2a", "background:#f7edd6;color:#9a6a12");
    await send(REPORT_TO, `${log.sentAt ? "FINAL – " : ""}Factory Shop Cash Up – ${niceDate}`, html,
      late ? `Completed late - last signature at ${lastStr}` : "Completed on time");
    await logRef.set({ date: DATE, complete: true, martieFinalSent: true, finalSentAt: now }, { merge: true });
  } else {
    if (!log.sentAt) {  // the 7 pm run never happened: send what there is so Martie is not left without a report
      await send(REPORT_TO, `INCOMPLETE – Factory Shop Cash Up – ${niceDate}`, nothing
        ? `<div style="font-family:Arial,Helvetica,sans-serif"><p>No cash up was captured for <b>${esc(niceDate)}</b>.</p></div>`
        : reportHtml("Factory Shop Cash Up", `Incomplete: missing ${missing.join(", ")}.`),
        nothing ? undefined : `INCOMPLETE - missing ${missing.join(", ")}`);
    }
    await send(ALERT_TO, `Still missing at 9 pm – cash up ${niceDate}`, alertHtml(`The factory shop cash up for <b>${esc(niceDate)}</b> is still not fully signed at 9 pm.`));
    await logRef.set({ date: DATE, missingAt9pm: missing, checkedAt9pm: now }, { merge: true });
  }
} else {
  console.error('Use "seven" or "nine".'); process.exit(1);
}
process.exit(0);
