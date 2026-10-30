// Unit tests for cashup-core.js, the rules shared by the app, the PDF report and the email job.
// Like the other tests they pin what the code does today, odd parts included.
import { test } from "node:test";
import assert from "node:assert/strict";
import { snap } from "./harness/boot.mjs";
import * as core from "../cashup-core.js";
import { DAY, PRE, SUN, at, dayDocs, sheet } from "./harness/fixtures.mjs";

const SHOPS = ["wholesale", "retail", "citydeep"];

test("money: what typed amounts become", t => {
  const cases = ["", null, "12", "12.5", "12,5", "1 480,55", "1.480,55", "1,480.55", "1.234", "1,234", "1.2.3", ",5", "5,", "R 99", "-12", "1234567890123", "123456789012345.5", "abc"];
  snap(t, cases.map(v => [v, core.money(v)]));
});

test("num, R, RV, vcls", t => {
  const nums = ["", null, undefined, "12.50", "1 234,56", "1,234.56", "-5", "abc", "12abc3", 7, NaN];
  snap(t, { num: nums.map(v => [String(v), core.num(v)]), R: [0, 1, 1234.5, -1234.5, 0.005, 1e7, null].map(v => [v, core.R(v)]), RV: [0, 0.004, -0.004, 0.005, 12.3, -12.3, 1234.5].map(v => [v, core.RV(v), core.vcls(v)]) });
});

test("esc, safeImg, savedAtIso, csvQuote, toCsv", t => {
  snap(t, {
    esc: core.esc(`<a href="x">Tom & 'Jerry'</a>`),
    escNull: [core.esc(null), core.esc(undefined), core.esc(0)],
    safeImg: ["data:image/png;base64,QUJD", "data:image/png;base64,QU JD", "data:image/jpeg;base64,QUJD", "javascript:alert(1)", null].map(core.safeImg),
    savedAtIso: [core.savedAtIso({ at: { toDate: () => new Date("2026-10-28T10:00:00Z") }, atIso: "phone" }), core.savedAtIso({ atIso: "phone" }), core.savedAtIso({})],
    csv: core.toCsv([["a", 'b "q"', "c,d"], ["line\nbreak", "", "x"]], c => core.csvQuote(String(c))),
  });
});

test("payment lines and labels per shop", t => {
  const out = {};
  for (const d of [...SHOPS, "manager", "combined"]) out[d] = core.methodsFor(d).map(m => `${m.k}: ${core.methodLabel(m, d)}`);
  snap(t, out);
});

// The PDF report (report-pdf.js) and the email job (scripts/daily-check.mjs) each have their own copy of
// "which lines each shop uses". This is that copy, word for word, to prove it agrees with methodsFor().
const SHOP_LINES = { wholesale: null, retail: ["cash", "cashguard", "card", "snapscan"], citydeep: ["cash", "cashguard", "card", "snapscan"] };
const hasLine = (shop, k) => (k === "payfast" || k === "cardcbm") ? shop === "wholesale" : k === "petty" ? shop === "retail" : (!SHOP_LINES[shop] || SHOP_LINES[shop].includes(k));
test("methodsFor agrees with the PDF and email job's hasLine for every shop and line", () => {
  for (const shop of SHOPS)
    for (const m of core.METHODS) assert.equal(core.methodsFor(shop).some(x => x.k === m.k), hasLine(shop, m.k), `${shop} ${m.k}`);
});

test("normalize: blank sheets, older stored data, server signature time", t => {
  const raw = sheet(DAY, "retail", {
    lines: { card: ["100", "90"], eft: ["50.5", ""], shop2shop: ["20", "20"], cashguard: ["10", "5", "5"], petty: ["", "3"] },
    signedBy: "Rita Retail", signedAt: "2026-10-28T09:00:00.000Z",
  });
  raw.signedAtServer = { toDate: () => new Date("2026-10-28T09:00:05.000Z") };
  raw.updatedAtServer = "x";
  raw.reopenedAt = "y";
  raw.extra = { kept: true };
  snap(t, {
    blank: core.normalize(null, DAY, "wholesale"),
    retail: core.normalize(raw, DAY, "retail"),
    wholesaleRetainedCleared: core.normalize(sheet(DAY, "wholesale", { lines: { cashguard: ["1", "2", "3"] } }), DAY, "wholesale").lines.cashguard,
    rawUntouched: raw.lines.eft,
  });
});

test("totals per shop", t => {
  const docs = dayDocs(DAY);
  const out = {};
  for (const d of SHOPS) out[d] = core.totals(core.normalize(docs[`cashups/${DAY}_${d}`], DAY, d));
  snap(t, out);
});

test("dayInfo through the day", t => {
  const sig = (dept, time) => ({ status: "signed", signedAt: at(DAY, time), dept });
  const W = sig("wholesale", "17:00"), Rt = sig("retail", "17:05"), C = sig("citydeep", "17:10"), M = sig("manager", "18:30");
  const out = {};
  for (const [label, now, args] of [
    ["open, morning", `${DAY}T08:00:00+02:00`, [DAY, W, null, null, null]],
    ["open, 7 days ahead", `2026-10-21T08:00:00+02:00`, [DAY, null, null, null, null]],
    ["overdue", `${DAY}T19:00:01+02:00`, [DAY, W, Rt, null, C]],
    ["done", `${DAY}T20:00:00+02:00`, [DAY, W, Rt, M, C]],
    ["late", `${DAY}T21:00:00+02:00`, [DAY, W, Rt, { ...M, signedAt: at(DAY, "19:00") + "1" }, C]],
    ["late by a minute", `${DAY}T21:00:00+02:00`, [DAY, W, Rt, { ...M, signedAt: at(DAY, "19:01") }, C]],
    ["before City Deep, no City Deep needed", `${PRE}T20:00:00+02:00`, [PRE, W, Rt, M, null]],
    ["Sunday", `${SUN}T20:00:00+02:00`, [SUN, null, null, null, null]],
  ]) {
    t.mock.timers.enable({ apis: ["Date"], now: Date.parse(now) });
    out[label] = core.dayInfo(...args);
    t.mock.timers.reset();
  }
  snap(t, out);
});

test("dates", t => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse(`${DAY}T23:30:00+02:00`) });
  snap(t, { today: core.todayStr(), long: core.longDate(DAY), short: core.shortDate(DAY), time: core.timeStr("2026-10-28T15:04:00Z"), noTime: core.timeStr(""), badTime: core.timeStr("nope"), cdOn: [PRE, "2026-10-20", DAY, "", null].map(core.cdOn) });
});

test("dates, times and the 7 pm deadline are South African time whatever the device's time zone", t => {
  const seen = {};
  for (const zone of ["Africa/Johannesburg", "America/New_York", "Pacific/Auckland", "UTC"]) {
    process.env.TZ = zone;
    const at = iso => { t.mock.timers.enable({ apis: ["Date"], now: Date.parse(iso) }); };
    const out = {};
    at("2026-10-29T00:30:00+02:00"); // just after midnight in South Africa
    out.today = core.todayStr();
    t.mock.timers.reset();
    out.long = core.longDate(DAY);
    out.short = core.shortDate(SUN);
    out.time = core.timeStr("2026-10-28T17:30:00Z");
    out.stamp = core.sastStamp("2026-10-28T22:15:00Z");
    at("2026-10-28T19:00:30+02:00"); // half a minute after the deadline
    out.deadline = core.dayInfo(DAY, null, null, null, null).kind;
    t.mock.timers.reset();
    at("2026-10-28T18:30:00+02:00");
    out.countdown = core.dayInfo(DAY, null, null, null, null).label;
    t.mock.timers.reset();
    out.sunday = core.dayInfo(SUN, null, null, null, null).kind;
    seen[zone] = out;
  }
  process.env.TZ = "Africa/Johannesburg";
  for (const zone of Object.keys(seen)) assert.deepEqual(seen[zone], seen["Africa/Johannesburg"], zone);
  snap(t, seen["Africa/Johannesburg"]);
});

test("bigVariances: lines more than R1000 out, short or over; petty cash never counts", t => {
  const s = (dept, lines) => core.normalize(sheet(DAY, dept, { lines }), DAY, dept);
  const pick = doc => core.bigVariances(doc).map(x => `${x.m.k} ${x.variance}`);
  snap(t, {
    exactly1000: pick(s("wholesale", { cash: ["2000", "1000"], card: ["0", "1000"] })),
    justOver: pick(s("wholesale", { cash: ["2000", "999.99"], card: ["0", "1000.01"] })),
    roundsToCents: pick(s("wholesale", { cash: ["1000.004", "0"] })),
    cashguardRetainedCounts: pick(s("retail", { cashguard: ["5000", "3000", "500"] })),
    pettyIgnored: pick(s("retail", { petty: ["", "5000"] })),
    eftOnRetailIsCard: pick(s("citydeep", { card: ["0", "600"], eft: ["0", "600"] })),
  });
});
