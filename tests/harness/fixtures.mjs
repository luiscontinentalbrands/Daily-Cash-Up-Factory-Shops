// Test data: the shop code, users with known PINs, and builders for stored cash up sheets.
import { webcrypto } from "node:crypto";
import { Timestamp } from "./fakes/firebase-firestore.mjs";

export const KEY = "TestShopKey0123456789abc";
export const PRE = "2026-10-17"; // Saturday, before City Deep Retail started
export const DAY = "2026-10-28"; // Wednesday, City Deep Retail included
export const SUN = "2026-10-25";
export const SIG = "data:image/png;base64,U0lHTkFUVVJF";
export const PHOTO = "data:image/jpeg;base64,UEhPVE8=";

export const USERS = [
  { id: "u-admin", name: "Ada Admin", role: "admin", pin: "2580" },
  { id: "u-whole", name: "Wanda Wholesale", role: "wholesale", pin: "1357" },
  { id: "u-retail", name: "Rita Retail", role: "retail", pin: "2468" },
  { id: "u-cd", name: "Cindy Deep", role: "citydeep", pin: "3690" },
  { id: "u-mgr", name: "Manny Manager", role: "manager", pin: "4826" },
  { id: "u-mgr2", name: "Mona Second", role: "manager", pin: "5937" },
  { id: "u-off", name: "Ollie Off", role: "wholesale", pin: "1112", active: false },
  { id: "u-del", name: "Dee Deleted", role: "retail", pin: "2223", active: false, deleted: true },
  { id: "u-new", name: "Nina New", role: "wholesale", pin: "0101", mustChange: true },
];

export async function pinHash(salt, pin) {
  const b = await webcrypto.subtle.digest("SHA-256", new TextEncoder().encode(salt + ":" + pin));
  return Array.from(new Uint8Array(b)).map(x => x.toString(16).padStart(2, "0")).join("");
}
export async function userDocs(users = USERS) {
  const out = {};
  for (const u of users) {
    const salt = "salt-" + u.id;
    const d = { name: u.name, role: u.role, active: u.active !== false, salt, pinHash: await pinHash(salt, u.pin) };
    if (u.mustChange) d.mustChange = true;
    if (u.deleted) d.deleted = true;
    out["users/" + u.id] = d;
  }
  return out;
}

export const ts = iso => new Timestamp(Date.parse(iso));

// A stored sheet. lines: {cash: [report, deposited], cashguard: [report, deposited, retained], ...}
export function sheet(date, dept, o = {}) {
  const lines = {};
  for (const [k, v] of Object.entries(o.lines || {})) {
    lines[k] = { report: v[0] ?? "", deposited: v[1] ?? "" };
    if (v.length > 2) lines[k].retained = v[2];
  }
  const d = {
    date, dept, cashier: o.cashier ?? "", lines,
    damaged: o.damaged ?? "", damagedNotes: o.damagedNotes ?? "", notes: o.notes ?? "",
    status: o.status ?? (o.signedBy ? "signed" : "draft"),
    signature: o.signedBy ? SIG : "", signedBy: o.signedBy ?? "", signedAt: o.signedAt ?? "",
    updatedAt: o.updatedAt ?? `${date}T08:00:00.000Z`,
  };
  if (o.pettyNotes !== undefined) d.pettyNotes = o.pettyNotes;
  if (o.signedAt && o.server !== false) d.signedAtServer = ts(o.signedAt);
  if (o.aiFill) d.aiFill = o.aiFill;
  return d;
}
export const at = (date, hhmm) => new Date(`${date}T${hhmm}:00+02:00`).toISOString();

// A typical day: every shop has figures; `signed` lists which sheets are signed (at 17:00, manager 18:30).
export function dayDocs(date, { signed = [], late = false } = {}) {
  const sig = (dept, who, time) => (signed.includes(dept) ? { signedBy: who, signedAt: at(date, late && dept === "manager" ? "19:40" : time) } : {});
  const docs = {
    [`cashups/${date}_wholesale`]: sheet(date, "wholesale", {
      cashier: "Wanda Wholesale", notes: "R50 short, float counted twice", damaged: "100.00", damagedNotes: "1 x R100 torn",
      lines: { cash: ["1500.00", "1450.00"], cashguard: ["2000.00", "2000.00"], card: ["3200.50", "3200.50"], cardcbm: ["410.00", "410.00"], payfast: ["99.99", "99.99"], eft: ["800.00", "800.00"], shop2shop: ["120.00", "120.00"], snapscan: ["45.00", "45.00"] },
      ...sig("wholesale", "Wanda Wholesale", "17:00"),
    }),
    [`cashups/${date}_retail`]: sheet(date, "retail", {
      cashier: "Rita Retail", pettyNotes: "R200 cleaning materials", notes: "",
      lines: { cash: ["35.50", "35.50"], cashguard: ["5400.00", "4900.00", "300.00"], card: ["2750.25", "2750.25"], snapscan: ["60.00", "60.00"], petty: ["", "200.00"] },
      ...sig("retail", "Rita Retail", "17:05"),
    }),
    [`cashups/${date}_manager`]: sheet(date, "manager", { status: signed.includes("manager") ? "signed" : "new", ...sig("manager", "Manny Manager", "18:30") }),
  };
  if (date >= "2026-10-20") docs[`cashups/${date}_citydeep`] = sheet(date, "citydeep", {
    cashier: "Cindy Deep", notes: "Card machine offline 10 minutes",
    lines: { cash: ["12.00", "12.00"], cashguard: ["3100.00", "3000.00", "150.00"], card: ["1999.95", "1980.00"], snapscan: ["", ""] },
    ...sig("citydeep", "Cindy Deep", "17:10"),
  });
  if (!signed.includes("manager")) docs[`cashups/${date}_manager`].status = "new";
  return docs;
}
