// The cash-up rules shared by the app (app.js), the PDF report (report-pdf.js) and the 7 pm email job
// (scripts/daily-check.mjs): payment lines per shop, amounts, dates, totals and the 7 pm deadline.
// Plain JavaScript with no page or database access, so it runs in the browser and in Node.

export const METHODS = [
  { k: "cash", l: "Cash" },
  { k: "cashguard", l: "CashGuard" },
  { k: "card", l: "Credit card" },
  { k: "cardcbm", l: "Credit card CBM" }, // Wholesale only
  { k: "payfast", l: "PayFast card" }, // Wholesale only
  { k: "eft", l: "EFT" },
  { k: "shop2shop", l: "Shop2Shop" },
  { k: "snapscan", l: "SnapScan" },
  { k: "petty", l: "Petty cash (not banked)" }, // Aeroton Retail only: cash taken for petty cash, counted but not banked (no report figure)
];
export const DEPTS = {
  wholesale: "Wholesale",
  retail: "Aeroton Retail",
  citydeep: "City Deep Retail",
  manager: "Manager",
};
// City Deep is a separate shop with its own cash up; it is required from this date
export const CD_START = "2026-10-20";
// Every sheet and the manager must be signed by this hour (7 pm)
export const DEADLINE_HOUR = 19;
export const cdOn = date => String(date || "") >= CD_START;
export const SHEETS = ["wholesale", "retail", "citydeep"];
// The stored sheets of one day, one per shop plus the manager's sign-off; null until loaded
export const noSheets = () => ({ wholesale: null, retail: null, manager: null, citydeep: null });
export const isMgr = d => d === "manager";
export const hasSplit = d => d === "retail" || d === "citydeep"; // CashGuard: Nedbank + counted & retained, not banked
// The two retail shops (Aeroton Retail, City Deep Retail): cash is coins, no EFT line (EFT slips are credit card payments), no Shop2Shop
export const isRetail = d => d === "retail" || d === "citydeep";
export const methodsFor = dept =>
  METHODS.filter(m =>
    m.k === "petty"
      ? dept === "retail"
      : m.k === "payfast" || m.k === "cardcbm"
        ? dept === "wholesale"
        : isRetail(dept)
          ? m.k !== "eft" && m.k !== "shop2shop"
          : true,
  );
export const methodLabel = (m, dept) =>
  m.k === "cash" ? (isRetail(dept) ? "Coins" : dept === "wholesale" ? "Cash" : "Cash / Coins (Retail shops)") : m.l;
const fmt = new Intl.NumberFormat("en-ZA", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const R = v => "R " + fmt.format(v || 0);
export const RV = v => {
  const a = Math.round(v * 100) / 100;
  if (a === 0) return "R 0.00";
  return (a > 0 ? "+" : "−") + "R " + fmt.format(Math.abs(a));
};
export const vcls = v => {
  const a = Math.round(v * 100) / 100;
  return a === 0 ? "var-zero" : a > 0 ? "var-pos" : "var-neg";
};
export const num = s => {
  if (s === "" || s == null) return 0;
  const n = parseFloat(String(s).replace(/[^0-9.\-]/g, ""));
  return isFinite(n) ? n : 0;
};
export const esc = s =>
  String(s == null ? "" : s).replace(
    /[&<>"']/g,
    c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
export const safeImg = s => (/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(String(s || "")) ? s : "");
export function todayStr() {
  const d = new Date();
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}
export function longDate(s) {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-ZA", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}
export function shortDate(s) {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-ZA", {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}
// When a record was saved: the server time once it has arrived, otherwise the time the phone noted
export const savedAtIso = x => (x.at && x.at.toDate ? x.at.toDate().toISOString() : x.atIso);
export function timeStr(iso) {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleString("en-ZA", {
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch (e) {
    return "";
  }
}
// CSV: a cell with a comma, quote or line break goes in quotes; rows are joined with cell() applied to each cell
export const csvQuote = c => (/[",\n]/.test(c) ? '"' + c.replace(/"/g, '""') + '"' : c);
export const toCsv = (rows, cell) => rows.map(r => r.map(cell).join(",")).join("\n");
export function clone(o) {
  return JSON.parse(JSON.stringify(o));
}

// CashGuard has two "deposited" amounts: banked in Nedbank (deposited) and counted but retained, not yet banked (retained)
export const depositedTotal = ln => num(ln && ln.deposited) + num(ln && ln.retained);
export function blank(date, dept) {
  const lines = {};
  METHODS.forEach(
    m =>
      (lines[m.k] = m.k === "cashguard" ? { report: "", deposited: "", retained: "" } : { report: "", deposited: "" }),
  );
  return {
    date,
    dept,
    cashier: "",
    lines,
    damaged: "",
    damagedNotes: "",
    notes: "",
    status: "new",
    signature: "",
    signedBy: "",
    signedAt: "",
    updatedAt: "",
  };
}
export function normalize(raw, date, dept) {
  const b = blank(date, dept);
  if (!raw) return b;
  const r = Object.assign({}, raw);
  // trust the server clock for signature times, not the phone's
  if (raw.signedAtServer && typeof raw.signedAtServer.toDate === "function")
    r.signedAt = raw.signedAtServer.toDate().toISOString();
  delete r.signedAtServer;
  delete r.updatedAtServer;
  delete r.reopenedAt;
  const o = Object.assign(b, clone(r));
  METHODS.forEach(m => {
    o.lines[m.k] = Object.assign(
      m.k === "cashguard" ? { report: "", deposited: "", retained: "" } : { report: "", deposited: "" },
      (raw.lines || {})[m.k] || {},
    );
  });
  if (!hasSplit(dept)) o.lines.cashguard.retained = ""; // the "retained, not banked" amount is only on Retail and City Deep
  // The retail shops have no Shop2Shop line, and their EFT slips are card-machine payments: sheets saved before
  // that rule still have EFT figures, which are added to Credit card here.
  if (isRetail(dept)) {
    o.lines.shop2shop = { report: "", deposited: "" };
  }
  if (isRetail(dept)) {
    const e = o.lines.eft,
      c = o.lines.card;
    ["report", "deposited"].forEach(f => {
      if (e[f] !== "" && e[f] != null) {
        c[f] = (num(c[f]) + num(e[f])).toFixed(2);
        e[f] = "";
      }
    });
  }
  return o;
}
export function totals(doc) {
  let r = 0,
    d = 0;
  methodsFor(doc.dept).forEach(m => {
    r += num(doc.lines[m.k].report);
    d += depositedTotal(doc.lines[m.k]);
  });
  const ret = num(doc.lines.cashguard && doc.lines.cashguard.retained);
  const pet = doc.dept === "retail" ? num(doc.lines.petty && doc.lines.petty.deposited) : 0;
  return { report: r, deposited: d, variance: d - r, retained: ret, petty: pet, banked: d - ret - pet };
}

/* Deadline: every trading day (Mon–Sat) every shop sheet and the manager's sign-off by DEADLINE_HOUR,
   by the clock and time zone of the device showing it */
export function dayInfo(date, W, Rt, M, C) {
  const [y, m, d] = date.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  if (dt.getDay() === 0) return { kind: "sunday", label: "Sunday · not a trading day", cls: "", missing: [] };
  const dl = new Date(y, m - 1, d, DEADLINE_HOUR, 0, 0);
  const missing = [];
  const all = [W, Rt, M];
  if (!(W && W.status === "signed")) missing.push("Wholesale");
  if (!(Rt && Rt.status === "signed")) missing.push("Aeroton Retail");
  if (!(M && M.status === "signed")) missing.push("Manager");
  if (cdOn(date)) {
    all.push(C);
    if (!(C && C.status === "signed")) missing.push("City Deep Retail");
  }
  if (!missing.length) {
    const last = Math.max(...all.map(x => Date.parse(x.signedAt) || 0));
    return last > dl.getTime()
      ? { kind: "late", label: "Completed late · " + timeStr(new Date(last).toISOString()), cls: "draft", missing }
      : { kind: "done", label: "Completed on time", cls: "signed", missing };
  }
  const now = Date.now();
  if (now > dl.getTime())
    return { kind: "overdue", label: "Overdue · missing " + missing.join(", "), cls: "bad", missing };
  const mins = Math.round((dl.getTime() - now) / 60000);
  return {
    kind: "open",
    label:
      mins < 24 * 60
        ? `Due by 7 pm · ${Math.floor(mins / 60)}h ${mins % 60}m left`
        : "Due by 7 pm on " + shortDate(date),
    cls: "draft",
    missing,
  };
}

// A typed amount as stored: digits with a point for the cents. It may be typed with a comma or a point:
// 1480,55 / 1480.55 / 1 480,55 / 1.480,55 / 1,480.55. The last comma or point is the decimal mark
// (1 or 2 digits after it); 3 digits after it means a thousands separator.
export const money = v => {
  const t = String(v == null ? "" : v).replace(/[^0-9.,]/g, "");
  const last = Math.max(t.lastIndexOf("."), t.lastIndexOf(","));
  if (last < 0) return t.slice(0, 12);
  const whole = t.slice(0, last).replace(/[.,]/g, ""),
    dec = t.slice(last + 1).replace(/[.,]/g, "");
  if (dec.length >= 3) return (whole + dec).slice(0, 12);
  return (whole || "0") + "." + dec;
};
