// Builds the End of Day cash up report as a PDF.
// Shared by the app (browser) and the 7 pm / 9 pm email job (Node), so both produce the same document.
// Usage: buildReportPdf(jsPDF, {date, niceDate, W, Rt, M, status, photos})  →  jsPDF document
//   W / Rt / M: the Wholesale, Retail and Manager sheets (may be null)
//   photos: [{dept, data (jpeg data URL), by, takenAt}] (optional, removed photos already filtered out)

const METHODS = [
  ["cash", "Cash"], ["cashguard", "CashGuard"], ["card", "Credit card"],
  ["eft", "EFT"], ["shop2shop", "Shop2Shop"], ["snapscan", "SnapScan"],
];
const num = s => { if (s === "" || s == null) return 0; const n = parseFloat(String(s).replace(/[^0-9.\-]/g, "")); return isFinite(n) ? n : 0; };
const fmt = new Intl.NumberFormat("en-ZA", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
// standard PDF fonts have no special spaces or minus signs: keep to plain characters
const plain = s => String(s ?? "").replace(/[   ]/g, " ").replace(/−/g, "-").replace(/[^\x20-\x7e\xa0-\xff]/g, "");
const R = v => plain("R " + fmt.format(v || 0));
const RV = v => { const a = Math.round(v * 100) / 100; return a === 0 ? "R 0.00" : (a > 0 ? "+" : "-") + R(Math.abs(a)); };
const TZ = "Africa/Johannesburg";
const when = iso => { if (!iso) return ""; try { return plain(new Date(iso).toLocaleString("en-ZA", { timeZone: TZ, day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" })); } catch (e) { return ""; } };
const line = (doc, k, f) => num(doc?.lines?.[k]?.[f]);
const isPng = s => /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(String(s || ""));
const isJpg = s => /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(String(s || ""));

export function buildReportPdf(jsPDF, d) {
  const { W, Rt, M } = d;
  const pdf = new jsPDF({ orientation: "landscape", unit: "mm", format: "a4" });
  const PW = pdf.internal.pageSize.getWidth(), PH = pdf.internal.pageSize.getHeight(), X = 14;
  let y = 16;
  const ink = () => pdf.setTextColor(31, 28, 24), grey = () => pdf.setTextColor(122, 114, 104);
  const vcol = v => { const a = Math.round(v * 100) / 100; if (a === 0) pdf.setTextColor(47, 107, 58); else if (a > 0) pdf.setTextColor(154, 106, 18); else pdf.setTextColor(176, 58, 42); };
  const text = (t, x, yy, o) => pdf.text(plain(t), x, yy, o);
  const wrap = (t, w) => pdf.splitTextToSize(plain(t), w);

  // header
  pdf.setFont("helvetica", "bold"); pdf.setFontSize(17); ink();
  text("Daily Factory Shop Cash Up", X, y);
  pdf.setFont("helvetica", "normal"); pdf.setFontSize(10); grey();
  text("Continental Brands", PW - X, y - 4, { align: "right" });
  text(d.niceDate || d.date, PW - X, y + 1, { align: "right" });
  y += 7;
  if (d.status) {
    const s = plain(d.status), ok = /on time/i.test(s);
    pdf.setFillColor(...(ok ? [228, 240, 230] : [247, 237, 214])); pdf.roundedRect(X, y - 4.5, PW - 2 * X, 7.5, 1.5, 1.5, "F");
    pdf.setFont("helvetica", "bold"); pdf.setFontSize(10); pdf.setTextColor(...(ok ? [47, 107, 58] : [154, 106, 18]));
    text(s, X + 3, y + 0.5); y += 9;
  }

  // table
  // column edges: payment type, then 7 amount columns
  const cw = (PW - 2 * X - 44) / 7, cols = [X, ...Array.from({ length: 8 }, (_, i) => X + 44 + i * cw)];
  const right = i => cols[i + 1] - 2;
  pdf.setFillColor(247, 244, 239); pdf.rect(X, y - 1, PW - 2 * X, 13, "F");
  pdf.setFont("helvetica", "bold"); pdf.setFontSize(9); ink();
  text("Wholesale", (cols[1] + cols[3]) / 2, y + 3.5, { align: "center" });
  text("Retail", (cols[3] + cols[5]) / 2, y + 3.5, { align: "center" });
  text("Combined", (cols[5] + cols[7]) / 2, y + 3.5, { align: "center" });
  text("Payment type", X + 2, y + 9);
  ["Report", "Deposited", "Report", "Deposited", "Report", "Deposited", "Variance"].forEach((h, i) => text(h, right(i + 1), y + 9, { align: "right" }));
  y += 12;
  pdf.setDrawColor(230, 225, 217); pdf.setLineWidth(0.2);
  let tWr = 0, tWd = 0, tRr = 0, tRd = 0;
  pdf.setFont("helvetica", "normal"); pdf.setFontSize(10);
  METHODS.forEach(([k, l]) => {
    const wr = line(W, k, "report"), wd = line(W, k, "deposited"), rr = line(Rt, k, "report"), rd = line(Rt, k, "deposited");
    tWr += wr; tWd += wd; tRr += rr; tRd += rd; const v = (wd + rd) - (wr + rr);
    y += 6.5; ink(); pdf.setFont("helvetica", "normal");
    text(l, X + 2, y);
    [wr, wd, rr, rd].forEach((n, i) => text(R(n), right(i + 1), y, { align: "right" }));
    pdf.setFont("helvetica", "bold"); text(R(wr + rr), right(5), y, { align: "right" }); text(R(wd + rd), right(6), y, { align: "right" });
    vcol(v); text(RV(v), right(7), y, { align: "right" });
    pdf.line(X, y + 2.2, PW - X, y + 2.2);
  });
  const gv = (tWd + tRd) - (tWr + tRr);
  y += 8; pdf.setDrawColor(31, 28, 24); pdf.setLineWidth(0.5); pdf.line(X, y - 5, PW - X, y - 5);
  pdf.setFont("helvetica", "bold"); ink(); text("Total", X + 2, y);
  [tWr, tWd, tRr, tRd, tWr + tRr, tWd + tRd].forEach((n, i) => text(R(n), right(i + 1), y, { align: "right" }));
  vcol(gv); text(RV(gv), right(7), y, { align: "right" });

  // details
  y += 10; pdf.setFontSize(10);
  const row = (label, value) => {
    pdf.setFont("helvetica", "bold"); ink(); text(label, X, y);
    pdf.setFont("helvetica", "normal"); const ls = wrap(value || "-", PW - 2 * X - 58); pdf.text(ls, X + 58, y); y += 5 * ls.length + 1;
  };
  row("Cashed up by", `Wholesale: ${W?.cashier || "-"}    Retail: ${Rt?.cashier || "-"}`);
  const dmg = num(W?.damaged) + num(Rt?.damaged);
  row("Damaged notes & coins", `Wholesale ${R(num(W?.damaged))}${W?.damagedNotes ? " (" + W.damagedNotes + ")" : ""}    Retail ${R(num(Rt?.damaged))}${Rt?.damagedNotes ? " (" + Rt.damagedNotes + ")" : ""}    Total ${R(dmg)}`);
  if (W?.notes) row("Wholesale notes", W.notes);
  if (Rt?.notes) row("Retail notes", Rt.notes);

  // signatures
  y += 3; if (y > PH - 48) { pdf.addPage(); y = 18; }
  const bw = (PW - 2 * X - 12) / 3;
  [["Wholesale", W], ["Retail", Rt], ["Manager", M]].forEach(([l, doc], i) => {
    const bx = X + i * (bw + 6);
    pdf.setDrawColor(230, 225, 217); pdf.setLineWidth(0.3); pdf.roundedRect(bx, y, bw, 38, 2, 2, "S");
    pdf.setFont("helvetica", "bold"); pdf.setFontSize(8); grey(); text(l.toUpperCase() + " SIGNATURE", bx + 3, y + 5);
    const signed = doc && doc.status === "signed";
    if (signed && isPng(doc.signature)) { try {
      const ip = pdf.getImageProperties(doc.signature), k = Math.min((bw - 6) / ip.width, 20 / ip.height);
      pdf.addImage(doc.signature, "PNG", bx + 3, y + 7, ip.width * k, ip.height * k, undefined, "FAST");
    } catch (e) { } }
    pdf.setFontSize(9);
    if (signed) { pdf.setFont("helvetica", "bold"); ink(); text(doc.signedBy || "", bx + 3, y + 31); pdf.setFont("helvetica", "normal"); grey(); text(when(doc.signedAt), bx + 3, y + 35.5); }
    else { pdf.setFont("helvetica", "bold"); pdf.setTextColor(176, 58, 42); text("NOT SIGNED", bx + 3, y + 20); }
  });
  y += 44;
  pdf.setFont("helvetica", "normal"); pdf.setFontSize(8); grey();
  text("Variance = deposited - report. Negative (red) is short; positive (amber) is over. Signature times come from the server clock (SAST).", X, Math.min(y, PH - 8));

  // report photos, one per page
  (d.photos || []).filter(p => isJpg(p.data)).forEach(p => {
    pdf.addPage("a4", "portrait");
    const pw = pdf.internal.pageSize.getWidth(), ph = pdf.internal.pageSize.getHeight();
    pdf.setFont("helvetica", "bold"); pdf.setFontSize(12); ink();
    text(`${p.dept === "retail" ? "Retail" : "Wholesale"} till report photo`, 14, 16);
    pdf.setFont("helvetica", "normal"); pdf.setFontSize(9); grey();
    text(`${d.niceDate || d.date}  -  added by ${p.by || "-"}${p.takenAt ? "  -  " + when(p.takenAt) : ""}`, 14, 21);
    try {
      const props = pdf.getImageProperties(p.data);
      const maxW = pw - 28, maxH = ph - 34; const k = Math.min(maxW / props.width, maxH / props.height);
      pdf.addImage(p.data, "JPEG", 14, 26, props.width * k, props.height * k, undefined, "FAST");
    } catch (e) { text("(photo could not be added)", 14, 32); }
  });
  return pdf;
}

export function reportFileName(date) { return `Cash-Up-${date}.pdf`; }
