// Builds the End of Day cash up report as a PDF.
// Shared by the app (browser) and the 7 pm / 9 pm email job (Node), so both produce the same document.
// Usage: buildReportPdf(jsPDF, {date, niceDate, W, Rt, M, C, CM, status, photos})  ->  jsPDF document
//   W / Rt / M: the Wholesale, Retail and factory-shop Manager sheets; C / CM: City Deep and its manager (omit before City Deep started)
//   photos: [{dept, data (jpeg data URL), by, takenAt}] (optional, removed photos already filtered out)

const METHODS = [
  ["cash", "Cash / Coins (Retail)"], ["cashguard", "CashGuard"], ["card", "Credit card"],
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

// Which lines each shop uses: Retail has no EFT or Shop2Shop; Retail and City Deep split CashGuard (Nedbank + not banked)
const SHOP_LINES = { wholesale: null, retail: ["cash", "cashguard", "card", "snapscan"], citydeep: null };
const hasLine = (shop, k) => !SHOP_LINES[shop] || SHOP_LINES[shop].includes(k);
const splitShop = shop => shop === "retail" || shop === "citydeep";
const depOf = (doc, shop, k) => line(doc, k, "deposited") + (splitShop(shop) ? line(doc, k, "retained") : 0);

export function buildReportPdf(jsPDF, d) {
  const { W, Rt, M, C, CM } = d;
  const shops = [["Wholesale", W, "wholesale"], ["Retail", Rt, "retail"]];
  if (C) shops.push(["City Deep", C, "citydeep"]);
  const pdf = new jsPDF({ orientation: "landscape", unit: "mm", format: "a4" });
  const PW = pdf.internal.pageSize.getWidth(), PH = pdf.internal.pageSize.getHeight(), X = 14;
  let y = 16;
  const ink = () => pdf.setTextColor(31, 28, 24), grey = () => pdf.setTextColor(122, 114, 104);
  const vcol = v => { const a = Math.round(v * 100) / 100; if (a === 0) pdf.setTextColor(47, 107, 58); else if (a > 0) pdf.setTextColor(154, 106, 18); else pdf.setTextColor(176, 58, 42); };
  const text = (t, x, yy, o) => pdf.text(plain(t), x, yy, o);
  const wrap = (t, w) => pdf.splitTextToSize(plain(t), w);

  // header
  pdf.setFont("helvetica", "bold"); pdf.setFontSize(17); ink();
  text(C ? "Daily Shops Cash Up" : "Daily Factory Shop Cash Up", X, y);
  pdf.setFont("helvetica", "normal"); pdf.setFontSize(10); grey();
  text(C ? "Continental Brands  -  Factory shop and City Deep" : "Continental Brands", PW - X, y - 4, { align: "right" });
  text(d.niceDate || d.date, PW - X, y + 1, { align: "right" });
  y += 7;
  if (d.status) {
    const s = plain(d.status), ok = /on time/i.test(s);
    pdf.setFillColor(...(ok ? [228, 240, 230] : [247, 237, 214])); pdf.roundedRect(X, y - 4.5, PW - 2 * X, 7.5, 1.5, 1.5, "F");
    pdf.setFont("helvetica", "bold"); pdf.setFontSize(10); pdf.setTextColor(...(ok ? [47, 107, 58] : [154, 106, 18]));
    text(s, X + 3, y + 0.5); y += 9;
  }

  // table: payment type, then report + deposited per shop, then all-shops report / deposited / variance
  const n = shops.length * 2 + 3, labW = 40, fs = C ? 8.5 : 10;
  const cw = (PW - 2 * X - labW) / n, cols = [X, ...Array.from({ length: n + 1 }, (_, i) => X + labW + i * cw)];
  const right = i => cols[i + 1] - 1.5;
  pdf.setFillColor(247, 244, 239); pdf.rect(X, y - 1, PW - 2 * X, 13, "F");
  pdf.setFont("helvetica", "bold"); pdf.setFontSize(9); ink();
  shops.forEach(([l], i) => text(l, (cols[1 + 2 * i] + cols[3 + 2 * i]) / 2, y + 3.5, { align: "center" }));
  text(C ? "All shops" : "Combined", (cols[1 + 2 * shops.length] + cols[n + 1]) / 2, y + 3.5, { align: "center" });
  pdf.setFontSize(C ? 8 : 9);
  text("Payment type", X + 2, y + 9);
  const heads = []; shops.forEach(() => heads.push("Report", "Deposited")); heads.push("Report", "Deposited", "Variance");
  heads.forEach((h, i) => text(h, right(i + 1), y + 9, { align: "right" }));
  y += 12;
  pdf.setDrawColor(230, 225, 217); pdf.setLineWidth(0.2);
  const tot = shops.map(() => [0, 0]);
  METHODS.forEach(([k, l]) => {
    y += 6.5; ink(); pdf.setFont("helvetica", "normal"); pdf.setFontSize(fs);
    text(l, X + 2, y);
    let r = 0, dd = 0;
    shops.forEach(([, doc, shop], i) => {
      if (!hasLine(shop, k)) { grey(); text("-", right(1 + 2 * i), y, { align: "right" }); text("-", right(2 + 2 * i), y, { align: "right" }); ink(); return; }
      const a = line(doc, k, "report"), b = depOf(doc, shop, k); r += a; dd += b; tot[i][0] += a; tot[i][1] += b;
      text(R(a), right(1 + 2 * i), y, { align: "right" }); text(R(b), right(2 + 2 * i), y, { align: "right" });
    });
    const v = dd - r, base = 2 * shops.length;
    pdf.setFont("helvetica", "bold"); text(R(r), right(base + 1), y, { align: "right" }); text(R(dd), right(base + 2), y, { align: "right" });
    vcol(v); text(RV(v), right(base + 3), y, { align: "right" });
    pdf.line(X, y + 2.2, PW - X, y + 2.2);
  });
  const gr = tot.reduce((a, t) => a + t[0], 0), gd = tot.reduce((a, t) => a + t[1], 0), gv = gd - gr;
  y += 8; pdf.setDrawColor(31, 28, 24); pdf.setLineWidth(0.5); pdf.line(X, y - 5, PW - X, y - 5);
  pdf.setFont("helvetica", "bold"); ink(); text("Total", X + 2, y);
  tot.forEach((t, i) => { text(R(t[0]), right(1 + 2 * i), y, { align: "right" }); text(R(t[1]), right(2 + 2 * i), y, { align: "right" }); });
  const base = 2 * shops.length;
  text(R(gr), right(base + 1), y, { align: "right" }); text(R(gd), right(base + 2), y, { align: "right" });
  vcol(gv); text(RV(gv), right(base + 3), y, { align: "right" });

  // details
  y += 10; pdf.setFontSize(10);
  const row = (label, value) => {
    pdf.setFont("helvetica", "bold"); ink(); text(label, X, y);
    pdf.setFont("helvetica", "normal"); const ls = wrap(value || "-", PW - 2 * X - 58); pdf.text(ls, X + 58, y); y += 5 * ls.length + 1;
  };
  if (C) { const fv = (tot[0][1] + tot[1][1]) - (tot[0][0] + tot[1][0]), cv = tot[2][1] - tot[2][0];
    row("Variance by shop", `Factory shop ${RV(fv)}    City Deep ${RV(cv)}    All shops ${RV(gv)}`); }
  row("Cashed up by", shops.map(([l, doc]) => `${l}: ${doc?.cashier || "-"}`).join("    "));
  shops.filter(([, , s]) => splitShop(s)).forEach(([l, doc]) =>
    row(l + " CashGuard", `Deposited in Nedbank ${R(line(doc, "cashguard", "deposited"))}    Counted & retained, not banked ${R(line(doc, "cashguard", "retained"))}`));
  row("Damaged notes & coins", shops.map(([l, doc]) => `${l} ${R(num(doc?.damaged))}${doc?.damagedNotes ? " (" + doc.damagedNotes + ")" : ""}`).join("    ") + `    Total ${R(shops.reduce((a, [, doc]) => a + num(doc?.damaged), 0))}`);
  shops.forEach(([l, doc]) => { if (doc?.notes) row(l + " notes", doc.notes); });

  // signatures
  y += 3; if (y > PH - 48) { pdf.addPage(); y = 18; }
  const boxes = [["Wholesale", W], ["Retail", Rt], [C ? "Factory manager" : "Manager", M]];
  if (C) boxes.push(["City Deep", C], ["City Deep manager", CM]);
  const bw = (PW - 2 * X - 6 * (boxes.length - 1)) / boxes.length;
  boxes.forEach(([l, doc], i) => {
    const bx = X + i * (bw + 6);
    pdf.setDrawColor(230, 225, 217); pdf.setLineWidth(0.3); pdf.roundedRect(bx, y, bw, 38, 2, 2, "S");
    pdf.setFont("helvetica", "bold"); pdf.setFontSize(C ? 7 : 8); grey(); text(l.toUpperCase() + " SIGNATURE", bx + 3, y + 5);
    const signed = doc && doc.status === "signed";
    if (signed && isPng(doc.signature)) { try {
      const ip = pdf.getImageProperties(doc.signature), k = Math.min((bw - 6) / ip.width, 20 / ip.height);
      pdf.addImage(doc.signature, "PNG", bx + 3, y + 7, ip.width * k, ip.height * k, undefined, "FAST");
    } catch (e) { } }
    pdf.setFontSize(C ? 8 : 9);
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
    text(`${p.dept === "retail" ? "Retail" : p.dept === "citydeep" ? "City Deep" : "Wholesale"} till report photo`, 14, 16);
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
