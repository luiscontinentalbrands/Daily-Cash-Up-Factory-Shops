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
  // Aeroton Retail only: cash paid out as petty cash, not banked. Not a payment line of its own: it is entered
  // under CashGuard and taken off what CashGuard counted (see countedTotal).
  { k: "petty", l: "Petty cash (not banked)" },
];
// The payment types shown as lines (petty cash is part of CashGuard)
export const PAYMENT_METHODS = METHODS.filter(m => m.k !== "petty");
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
  PAYMENT_METHODS.filter(m =>
    m.k === "payfast" || m.k === "cardcbm"
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
  if (a === 0) return R(0);
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
// Every date and time in the cash up is South African time (SAST, UTC+2 all year, no daylight saving),
// whatever time zone the phone or computer is set to.
export const TZ = "Africa/Johannesburg";
const SAST_OFFSET = "+02:00";
// The parts of a moment in South African time: { year, month, day, hour, minute, second } as 2-digit strings
function sastParts(t) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(t);
  return Object.fromEntries(parts.map(p => [p.type, p.value]));
}
// Today's date in South Africa, YYYY-MM-DD
export function todayStr() {
  const p = sastParts(new Date());
  return `${p.year}-${p.month}-${p.day}`;
}
// A YYYY-MM-DD date as a moment on that day (noon in South Africa), for showing it in words
const onDay = s => new Date(`${s}T12:00:00${SAST_OFFSET}`);
export function longDate(s) {
  return onDay(s).toLocaleDateString("en-ZA", {
    timeZone: TZ,
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}
export function shortDate(s) {
  return onDay(s).toLocaleDateString("en-ZA", {
    timeZone: TZ,
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
      timeZone: TZ,
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch (e) {
    return "";
  }
}
// A moment as "YYYY-MM-DD HH:MM" in South African time, for CSV files ("" when there is none)
export function sastStamp(iso) {
  if (!iso) return "";
  const t = new Date(iso);
  if (isNaN(t)) return String(iso);
  const p = sastParts(t);
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}
// CSV: a cell with a comma, quote or line break goes in quotes; rows are joined with cell() applied to each cell
export const csvQuote = c => (/[",\n]/.test(c) ? '"' + c.replace(/"/g, '""') + '"' : c);
export const toCsv = (rows, cell) => rows.map(r => r.map(cell).join(",")).join("\n");
// A CSV cell; text that starts with = + - @ gets a ' in front so spreadsheets do not run it as a formula
// (plain numbers such as -12.50 stay as they are)
export const csvCell = c => {
  c = String(c == null ? "" : c);
  if (/^[=+\-@]/.test(c) && !/^-?\d+(\.\d+)?$/.test(c)) c = "'" + c;
  return csvQuote(c);
};
export function clone(o) {
  return JSON.parse(JSON.stringify(o));
}

// What was counted for a payment line of a sheet (the Deposited column). On the retail shops CashGuard has more
// than one amount: deposited in Nedbank plus counted & retained (not banked), and on Aeroton Retail minus the petty
// cash paid out of it. Works on a missing sheet (0).
export function countedTotal(doc, k) {
  const lines = (doc && doc.lines) || {};
  const amount = (key, f) => num(lines[key] && lines[key][f]);
  let c = amount(k, "deposited");
  if (k === "cashguard" && hasSplit(doc && doc.dept)) c += amount("cashguard", "retained");
  if (k === "cashguard" && doc && doc.dept === "retail") c -= amount("petty", "deposited");
  return c;
}
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
    d += countedTotal(doc, m.k);
  });
  const ret = num(doc.lines.cashguard && doc.lines.cashguard.retained);
  const pet = doc.dept === "retail" ? num(doc.lines.petty && doc.lines.petty.deposited) : 0;
  // banked: what was counted less what was kept back (retained), adding back the petty cash already taken off
  return { report: r, deposited: d, variance: d - r, retained: ret, petty: pet, banked: d - ret + pet };
}

// A payment line more than this many rand out, short or over, must be checked again before the sheet is signed
export const BIG_VARIANCE = 1000;
export const isBigVariance = v => Math.abs(Math.round(v * 100) / 100) > BIG_VARIANCE;
// The payment lines of a sheet that are more than BIG_VARIANCE out: [{ m, variance }]
export function bigVariances(doc) {
  return methodsFor(doc.dept)
    .map(m => ({ m, variance: Math.round((countedTotal(doc, m.k) - num(doc.lines[m.k].report)) * 100) / 100 }))
    .filter(x => isBigVariance(x.variance));
}

/* Deadline: every trading day (Mon–Sat) every shop sheet and the manager's sign-off by DEADLINE_HOUR, South African time */
export function dayInfo(date, W, Rt, M, C) {
  if (onDay(date).getUTCDay() === 0)
    return { kind: "sunday", label: "Sunday · not a trading day", cls: "", missing: [] };
  const dl = new Date(`${date}T${String(DEADLINE_HOUR).padStart(2, "0")}:00:00${SAST_OFFSET}`);
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
// (1 or 2 digits after it); 3 digits after it means a thousands separator. Amounts are never negative,
// and the rand part is cut to MONEY_DIGITS digits.
const MONEY_DIGITS = 12;
export const money = v => {
  const t = String(v == null ? "" : v).replace(/[^0-9.,]/g, "");
  const last = Math.max(t.lastIndexOf("."), t.lastIndexOf(","));
  if (last < 0) return t.slice(0, MONEY_DIGITS);
  const whole = t.slice(0, last).replace(/[.,]/g, ""),
    dec = t.slice(last + 1).replace(/[.,]/g, "");
  if (dec.length >= 3) return (whole + dec).slice(0, MONEY_DIGITS);
  return (whole || "0").slice(0, MONEY_DIGITS) + "." + dec;
};
