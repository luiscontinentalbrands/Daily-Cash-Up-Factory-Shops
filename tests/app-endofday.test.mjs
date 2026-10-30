// Characterization tests: End of Day (combined view), its banners, CSV, PDF and email.
import { test } from "node:test";
import assert from "node:assert/strict";
import { boot, snap } from "./harness/boot.mjs";
import { DAY, PRE, SUN, at, dayDocs, ts } from "./harness/fixtures.mjs";

const ALL = ["wholesale", "retail", "citydeep", "manager"];
const handovers = date => ({
  "handovers/h1": { date, shop: "retail", amount: 300, givenBy: "Rita Retail", receivedBy: "Candido", note: "sealed", signature: "data:image/png;base64,SEFORA==", at: ts(at(date, "17:30")), atIso: at(date, "17:30") },
  "handovers/h2": { date, shop: "retail", amount: "200.5", givenBy: "Rita Retail", receivedBy: "Candido", note: "", signature: "bad", atIso: at(date, "17:45") },
});

test("End of Day screen through the day", async t => {
  const cases = [
    ["open, nothing signed", DAY, "10:00", {}],
    ["open, last hour", DAY, "18:15", { signed: ["wholesale"] }],
    ["overdue", DAY, "19:30", { signed: ["wholesale", "retail"] }],
    ["closed late", DAY, "21:00", { signed: ALL, late: true }],
    ["closed on time", DAY, "20:00", { signed: ALL }],
    ["before City Deep", PRE, "20:00", { signed: ["wholesale", "retail", "manager"] }],
    ["Sunday", SUN, "12:00", {}],
    ["tomorrow, seen today", "2026-10-29", "12:00", {}],
  ];
  for (const [label, date, time, opts] of cases) {
    const app = await boot(t, { me: "u-mgr", now: `${DAY}T${time}:00+02:00`, docs: { ...dayDocs(date, opts), ...handovers(date) } });
    if (date !== DAY) await app.date(date);
    snap(t, app.html(), label);
    t.mock.timers.reset();
  }
});

test("City Deep before its start date shows once it has figures", async t => {
  const docs = dayDocs(PRE);
  docs[`cashups/${PRE}_citydeep`] = { ...dayDocs(DAY)[`cashups/${DAY}_citydeep`], date: PRE };
  const app = await boot(t, { me: "u-admin", now: `${PRE}T12:00:00+02:00`, docs });
  await app.tab("combined");
  snap(t, app.html(".summary"), "summary");
  snap(t, app.html("thead"), "columns");
});

test("download the day as CSV", async t => {
  const docs = dayDocs(DAY, { signed: ALL });
  docs[`cashups/${DAY}_wholesale`].notes = '=SUM(A1) "quoted", with comma\nand a new line';
  docs[`cashups/${DAY}_retail`].pettyNotes = "-R20 refund";
  const app = await boot(t, { me: "u-mgr", now: `${DAY}T20:00:00+02:00`, docs });
  await app.click("#csv");
  assert.equal(app.env.downloads.length, 1);
  const [d] = app.env.downloads;
  assert.equal(d.name, `cash-up-${DAY}.csv`);
  snap(t, await d.blob.text(), "csv");
  snap(t, app.text("#csv-msg"), "message");
  t.mock.timers.reset();
  const pre = await boot(t, { me: "u-mgr", now: `${PRE}T20:00:00+02:00`, docs: dayDocs(PRE) });
  await pre.date(PRE);
  await pre.click("#csv");
  snap(t, await pre.env.downloads[0].blob.text(), "csv before City Deep");
});

test("download the PDF report", async t => {
  const app = await boot(t, { me: "u-mgr", now: `${DAY}T20:00:00+02:00`, docs: { ...dayDocs(DAY, { signed: ALL }), ...handovers(DAY), "photos/p1": { date: DAY, dept: "retail", data: "data:image/jpeg;base64,UA==", by: "Rita Retail", takenAt: at(DAY, "16:00") } } });
  await app.click("#pdf-dl");
  snap(t, app.text("#csv-msg"), "message");
  const [d] = app.env.downloads;
  assert.equal(d.name, `Cash-Up-${DAY}.pdf`);
  snap(t, await d.blob.text(), "pdf drawing calls");
  assert.deepEqual(app.env.scripts, ["https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js"]);
  await app.advance(60000);
  assert.deepEqual(app.env.revoked, [d.href]);
});

test("email the PDF: share sheet, cancelled share, or download plus mailto", async t => {
  const docs = dayDocs(DAY, { signed: ALL });
  const app = await boot(t, { me: "u-mgr", now: `${DAY}T20:00:00+02:00`, docs });
  await app.click("#pdf-mail");
  snap(t, { message: app.text("#csv-msg"), downloads: app.env.downloads.map(d => d.name), mailto: app.env.navigations }, "computer");
  t.mock.timers.reset();
  const phone = await boot(t, { me: "u-mgr", now: `${DAY}T20:00:00+02:00`, docs });
  phone.env.navigator.canShare = () => true;
  phone.env.navigator.share = async data => { phone.env.shares.push({ title: data.title, text: data.text, files: data.files.map(f => [f.name, f.type]) }); };
  await phone.click("#pdf-mail");
  snap(t, { message: phone.text("#csv-msg"), shares: phone.env.shares, downloads: phone.env.downloads.length }, "phone");
  phone.env.navigator.share = async () => { throw Object.assign(new Error("cancelled"), { name: "AbortError" }); };
  await phone.click("#pdf-mail");
  snap(t, phone.text("#csv-msg"), "cancelled");
  phone.env.window.jspdf = null;
  phone.env.loadScript = sc => queueMicrotask(() => sc.onerror());
  t.mock.timers.reset();
  const broken = await boot(t, { me: "u-mgr", now: `${DAY}T20:00:00+02:00`, docs });
  broken.env.loadScript = sc => queueMicrotask(() => sc.onerror());
  await broken.click("#pdf-dl");
  snap(t, broken.text("#csv-msg"), "PDF tool unavailable");
});

test("End of Day table: one view at a time, switched with the shop buttons", async t => {
  const docs = dayDocs(DAY, { signed: ["wholesale", "retail", "citydeep"] });
  docs[`cashups/${DAY}_citydeep`].lines.card = { report: "2500.00", deposited: "1000.00" };
  const app = await boot(t, { me: "u-mgr", now: `${DAY}T18:00:00+02:00`, docs });
  snap(t, app.html(".eodviews"), "buttons");
  const views = {};
  for (const v of ["all", "wholesale", "retail", "citydeep"]) {
    await app.click(`[data-eod="${v}"]`);
    views[v] = app.all("table.eod tr").map(r => r.children.map(c => c.textContent.trim()).join(" | ") + (r.className ? `  [${r.className}]` : ""));
  }
  snap(t, views, "views");
  assert.equal(app.$('[data-eod="citydeep"]').getAttribute("aria-pressed"), "true");
  // the chosen view stays when the screen is redrawn, and switching keeps a signature being drawn
  await app.draw("#pad");
  await app.click('[data-eod="retail"]');
  assert.equal(app.$("#pad").dataset.inked, "1");
  await app.advance(60000);
  assert.equal(app.$('[data-eod="retail"]').getAttribute("aria-pressed"), "true");
  t.mock.timers.reset();
  const pre = await boot(t, { me: "u-mgr", now: `${PRE}T18:00:00+02:00`, docs: dayDocs(PRE) });
  await pre.date(PRE);
  snap(t, pre.all(".eodview").map(b => b.textContent.trim()), "before City Deep");
});
