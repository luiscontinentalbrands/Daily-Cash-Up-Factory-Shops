// Characterization tests: the shop sheets (Wholesale, Aeroton Retail, City Deep Retail),
// typing amounts, saving, and live updates from other devices.
import { test } from "node:test";
import assert from "node:assert/strict";
import { boot, snap } from "./harness/boot.mjs";
import { KEY, DAY, PRE, at, dayDocs, sheet } from "./harness/fixtures.mjs";
import { setDoc, doc, getFirestore } from "./harness/fakes/firebase-firestore.mjs";

const remote = (path, data) => setDoc(doc(getFirestore(), "shops", KEY, ...path.split("/")), data);

test("empty sheets, as their own cashier/manager", async t => {
  for (const [me, tab] of [["u-whole", "wholesale"], ["u-retail", "retail"], ["u-cd", "citydeep"]]) {
    const app = await boot(t, { me });
    snap(t, app.html(), tab);
    t.mock.timers.reset();
  }
});

test("sheets with figures, draft and signed, seen by different roles", async t => {
  const cases = [
    ["u-whole", "wholesale", []], ["u-retail", "retail", []], ["u-cd", "citydeep", []],
    ["u-whole", "wholesale", ["wholesale"]], ["u-mgr", "retail", ["retail"]], ["u-admin", "citydeep", ["citydeep"]],
    ["u-retail", "wholesale", []], ["u-whole", "retail", ["wholesale", "retail", "citydeep", "manager"]],
    ["u-retail", "retail", ["wholesale", "retail", "citydeep", "manager"]],
  ];
  for (const [me, tab, signed] of cases) {
    const app = await boot(t, { me, docs: dayDocs(DAY, { signed }), now: `${DAY}T18:00:00+02:00` });
    await app.tab(tab);
    snap(t, app.html(), `${me} on ${tab}, signed: ${signed.join(",") || "none"}`);
    t.mock.timers.reset();
  }
});

test("before City Deep started: retail sheet and banner", async t => {
  const app = await boot(t, { me: "u-retail", now: `${PRE}T12:00:00+02:00`, docs: dayDocs(PRE) });
  snap(t, app.html());
});

test("older stored data is tidied on load (Retail EFT into card, no Shop2Shop, no Wholesale retained)", async t => {
  const docs = {
    [`cashups/${DAY}_retail`]: sheet(DAY, "retail", { lines: { card: ["100.00", "90.00"], eft: ["50.50", "50.50"], shop2shop: ["20.00", "20.00"], cashguard: ["10", "5", "5"] } }),
    [`cashups/${DAY}_wholesale`]: sheet(DAY, "wholesale", { lines: { cashguard: ["300", "250", "50"] } }),
  };
  const app = await boot(t, { me: "u-admin", docs });
  snap(t, app.html("tbody"), "wholesale rows");
  await app.tab("retail");
  snap(t, app.html("tbody"), "retail rows");
  snap(t, app.html("tfoot"), "retail totals");
  assert.deepEqual(app.writes(), []);
});

test("typing amounts: accepted formats, tidy on leaving the box, debounced save", async t => {
  const app = await boot(t, { me: "u-whole" });
  const seen = [];
  for (const v of ["1 480,55", "1.480,55", "1,480.55", "1480.5", "1.234", "12,5", ",5", "R 99", "1234567890123", "1.2.3", "abc"]) {
    await app.type("#wholesale-cash-report", v);
    const typed = app.$("#wholesale-cash-report").value, variance = app.text("#v-cash");
    await app.blur("#wholesale-cash-report");
    seen.push({ typed: v, inBox: typed, afterLeaving: app.$("#wholesale-cash-report").value, variance, total: app.text("#t-report") });
  }
  snap(t, seen, "formats");
  assert.deepEqual(app.writes(), [], "nothing saved before the pause");
  assert.equal(app.text("#saved-wholesale"), "Saving…");
  await app.advance(699);
  assert.deepEqual(app.writes(), [], "still waiting at 699 ms");
  await app.advance(1);
  snap(t, app.writes(), "one save after the pause");
  snap(t, app.text("#saved-wholesale"), "saved note");
});

test("notes, damaged notes and coins, petty cash details", async t => {
  const app = await boot(t, { me: "u-retail" });
  await app.type("#retail-damaged", "12,5x");
  await app.blur("#retail-damaged");
  await app.type("#retail-damagedNotes", "2 x R5 bent");
  await app.type("#retail-pettyNotes", "R200 cleaning");
  await app.type("#retail-notes", "Short R10\nfloat recount");
  await app.type("#retail-petty-deposited", "200");
  await app.type("#retail-cashguard-retained", "200");
  snap(t, app.html("#t-cg"), "same amount as retained and petty cash");
  await app.advance(700);
  snap(t, app.writes(), "saved");
  snap(t, app.html(".sheet.retail"), "sheet");
});

test("updates from another device: re-render, or patch while typing, or drop a stale draft", async t => {
  const app = await boot(t, { me: "u-whole", docs: dayDocs(DAY) });
  await remote(`cashups/${DAY}_wholesale`, { ...app.stored(`cashups/${DAY}_wholesale`), notes: "changed elsewhere", lines: { cash: { report: "1.00", deposited: "2.00" } } });
  await app.advance(0);
  snap(t, app.html("tbody tr"), "re-rendered, first row");
  assert.equal(app.$("#wholesale-notes").value, "changed elsewhere");
  // while the cursor is in a box, other boxes are patched in place
  await app.type("#wholesale-card-report", "5");
  await app.advance(700);
  app.writes();
  app.doc._focus(app.$("#wholesale-card-deposited"));
  await remote(`cashups/${DAY}_wholesale`, { ...app.stored(`cashups/${DAY}_wholesale`), lines: { cash: { report: "7.00", deposited: "7.00" }, card: { report: "5.00", deposited: "9.99" } } });
  await app.advance(0);
  assert.equal(app.doc.activeElement, app.$("#wholesale-card-deposited"), "not re-rendered");
  snap(t, { cash: app.$("#wholesale-cash-report").value, cardDeposited: app.$("#wholesale-card-deposited").value, total: app.text("#t-report") }, "patched");
  // typing not yet saved, then someone signs the sheet elsewhere: the draft is dropped
  await app.type("#wholesale-cash-report", "999");
  await remote(`cashups/${DAY}_wholesale`, { ...app.stored(`cashups/${DAY}_wholesale`), status: "signed", signedBy: "Someone Else", signedAt: at(DAY, "09:59") });
  await app.advance(700);
  snap(t, app.writes(), "no save after the remote signature");
  snap(t, app.text(".sheet.wholesale .chip"), "status chip");
});

test("save refused: message on the sheet and an alert", async t => {
  const app = await boot(t, { me: "u-whole", before: (env, db) => { db.rejectWrite = () => ({ code: "permission-denied" }); } });
  await app.type("#wholesale-cash-report", "10");
  await app.advance(700);
  snap(t, app.text("#saved-wholesale"), "sheet note");
  snap(t, app.html("#savealert"), "alert");
  await app.advance(20000);
  assert.equal(app.$("#savealert").hidden, true);
  t.mock.timers.reset();
  const off = await boot(t, { me: "u-whole", before: (env, db) => { db.rejectWrite = () => ({ code: "unavailable" }); } });
  await off.type("#wholesale-cash-report", "10");
  await off.advance(700);
  snap(t, off.text("#saved-wholesale"), "offline note");
});

test("leaving the page or switching tabs saves typing at once", async t => {
  const app = await boot(t, { me: "u-whole" });
  await app.type("#wholesale-cash-report", "10");
  app.env.document.visibilityState = "hidden";
  const { fire } = await import("./harness/dom.mjs");
  fire(app.doc, "visibilitychange");
  await app.advance(0);
  snap(t, app.writes().map(w => w.path), "hidden");
  await app.type("#wholesale-cash-report", "11");
  fire(app.env.window, "pagehide", {}, false);
  await app.advance(0);
  snap(t, app.writes().map(w => w.path), "pagehide");
});

test("changing the date and the minute refresh", async t => {
  const app = await boot(t, { me: "u-whole", docs: { ...dayDocs(DAY), ...dayDocs(PRE) }, now: `${DAY}T18:58:30+02:00` });
  snap(t, app.html(".banner"), "before 7 pm");
  await app.advance(60000);
  snap(t, app.html(".banner"), "after the minute refresh");
  await app.date(PRE);
  snap(t, app.html(".deptband"), "other date");
  await app.click("#today");
  assert.equal(app.$("#date").value, DAY);
});
