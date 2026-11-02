// Characterization tests: signing sheets, the manager's sign-off, reopening.
import { test } from "node:test";
import assert from "node:assert/strict";
import { boot, snap } from "./harness/boot.mjs";
import { DAY, PRE, dayDocs } from "./harness/fixtures.mjs";

test("signing a shop sheet: checks, then the signature and the audit entry", async t => {
  const app = await boot(t, { me: "u-whole", now: `${DAY}T16:00:00+02:00` });
  await app.click("#signbtn");
  snap(t, app.text("#sign-msg"), "empty sheet");
  await app.type("#wholesale-cash-report", "100");
  await app.click("#signbtn");
  snap(t, app.text("#sign-msg"), "no signature drawn");
  await app.draw("#pad");
  await app.advance(10000);
  await app.click("#clear");
  await app.click("#signbtn");
  snap(t, app.text("#sign-msg"), "cleared");
  await app.draw("#pad");
  await app.click("#signbtn");
  snap(t, app.writes(), "writes");
  snap(t, app.html(), "signed");
});

test("a signature that cannot be saved is undone", async t => {
  const app = await boot(t, { me: "u-whole", docs: dayDocs(DAY) });
  app.db.rejectWrite = () => new Error("Failed to fetch");
  await app.draw("#pad");
  await app.click("#signbtn");
  snap(t, app.text("#sign-msg"), "message");
  snap(t, app.text(".sheet.wholesale .chip"), "still not signed");
});

test("the live update waits while a signature is being drawn", async t => {
  const app = await boot(t, { me: "u-whole", docs: dayDocs(DAY) });
  await app.draw("#pad");
  await app.advance(60000);
  assert.ok(app.$("#pad").dataset.inked === "1", "pad kept");
  await app.click("#clear");
  assert.ok(app.has("#pad"));
});

test("manager sign-off: waiting for shops, different person, success", async t => {
  const app = await boot(t, { me: "u-mgr", docs: dayDocs(DAY, { signed: ["wholesale", "retail"] }), now: `${DAY}T18:00:00+02:00` });
  snap(t, app.html(".sheet:last-child .sheet-body"), "waiting for City Deep");
  t.mock.timers.reset();
  const docs = dayDocs(DAY, { signed: ["wholesale", "retail", "citydeep"] });
  docs[`cashups/${DAY}_retail`].signedBy = "Manny Manager";
  const same = await boot(t, { me: "u-mgr", docs, now: `${DAY}T18:00:00+02:00` });
  await same.draw("#pad");
  await same.click("#signbtn");
  snap(t, same.text("#sign-msg"), "same person signed a shop");
  t.mock.timers.reset();
  const ok = await boot(t, { me: "u-mgr", docs: dayDocs(DAY, { signed: ["wholesale", "retail", "citydeep"] }), now: `${DAY}T18:00:00+02:00` });
  await ok.click("#signbtn");
  snap(t, ok.text("#sign-msg"), "no signature");
  await ok.draw("#pad");
  await ok.click("#signbtn");
  snap(t, ok.writes(), "writes");
  snap(t, ok.html(), "day closed");
});

test("manager sign-off before City Deep started", async t => {
  const app = await boot(t, { me: "u-admin", docs: dayDocs(PRE, { signed: ["wholesale"] }), now: `${PRE}T18:00:00+02:00` });
  await app.tab("combined");
  snap(t, app.html(".sheet:last-child"), "admin waiting");
  t.mock.timers.reset();
  const ready = await boot(t, { me: "u-mgr", docs: dayDocs(PRE, { signed: ["wholesale", "retail"] }), now: `${PRE}T18:00:00+02:00` });
  snap(t, ready.html(".sheet:last-child .msg"), "sign text");
  t.mock.timers.reset();
  const cashier = await boot(t, { me: "u-whole", docs: dayDocs(PRE, { signed: ["wholesale", "retail"] }), now: `${PRE}T18:00:00+02:00` });
  await cashier.tab("combined");
  snap(t, cashier.html(".sheet:last-child .sheet-body"), "cashier view");
});

test("cashier reopens own sheet (tap twice), not after the day is closed", async t => {
  const app = await boot(t, { me: "u-whole", docs: dayDocs(DAY, { signed: ["wholesale"] }) });
  snap(t, app.html(".notice"), "lock notice");
  await app.click("#reopen");
  snap(t, [app.text("#reopen"), app.text("#reopen-msg")], "armed");
  await app.advance(4000);
  snap(t, [app.text("#reopen"), app.text("#reopen-msg")], "disarmed after 4 s");
  await app.click("#goreopen");
  await app.advance(350);
  assert.equal(app.text("#reopen"), "Tap again to reopen");
  await app.click("#reopen");
  snap(t, app.writes(), "reopened");
  snap(t, app.html(".sheet.wholesale .sheet-head"), "head");
  t.mock.timers.reset();
  const closed = await boot(t, { me: "u-whole", docs: dayDocs(DAY, { signed: ["wholesale", "retail", "citydeep", "manager"] }) });
  snap(t, closed.html(), "day closed");
});

test("manager reopens a sheet after the day is closed: the day reopens first", async t => {
  const app = await boot(t, { me: "u-mgr", docs: dayDocs(DAY, { signed: ["wholesale", "retail", "citydeep", "manager"] }) });
  await app.tab("retail");
  await app.click("#reopen");
  await app.click("#reopen");
  snap(t, app.writes(), "writes");
  snap(t, app.html(".sheet.retail .sheet-head"), "retail now");
  await app.tab("combined");
  snap(t, app.html(".sheet:last-child"), "manager block");
});

test("manager reopens the day from End of Day", async t => {
  const app = await boot(t, { me: "u-mgr", docs: dayDocs(DAY, { signed: ["wholesale", "retail", "citydeep", "manager"] }) });
  await app.click("#reopen");
  await app.click("#reopen");
  snap(t, app.writes(), "writes");
  t.mock.timers.reset();
  const fail = await boot(t, { me: "u-mgr", docs: dayDocs(DAY, { signed: ["wholesale", "retail", "citydeep", "manager"] }) });
  await fail.tab("retail");
  fail.db.rejectWrite = () => ({ code: "permission-denied" });
  await fail.click("#reopen");
  await fail.click("#reopen");
  snap(t, [fail.text("#reopen-msg"), fail.text("#savealert")], "could not reopen the day");
});

test("signing when the audit trail entry cannot be written", async t => {
  const app = await boot(t, { me: "u-whole", docs: dayDocs(DAY), before: (env, db) => { db.rejectWrite = (op, path) => (path.includes("/history/") ? { code: "permission-denied" } : null); } });
  await app.draw("#pad");
  await app.click("#signbtn");
  snap(t, { writes: app.writes().map(w => [w.op, w.path, w.rejected || "ok"]), chip: app.text(".sheet.wholesale .chip"), alert: app.has("#savealert") && !app.$("#savealert").hidden ? app.text("#savealert") : null });
});

test("store manager sign-off must be complete before a shop sheet can be signed", async t => {
  const app = await boot(t, { me: "u-whole", now: `${DAY}T16:00:00+02:00` });
  app.autoDeclare = false;
  await app.type("#wholesale-cash-report", "100");
  await app.draw("#pad");
  const tries = [];
  const attempt = async () => { await app.click("#signbtn"); tries.push(app.text("#sign-msg")); };
  await attempt();
  await app.type("#dt-wholesale-0-tx", "5");
  await attempt();
  await app.type("#dt-wholesale-0-slips", "4");
  await attempt();
  assert.match(app.text("#dd-wholesale-0"), /Slips \(4\) do not match transactions \(5\)/);
  await app.type("#dt-wholesale-0-reason", "One slip lost");
  await attempt();
  assert.notEqual(app.text(".sheet.wholesale .chip"), "Signed off");
  await app.declare();
  await app.click("#signbtn");
  assert.equal(app.text(".sheet.wholesale .chip"), "Signed off");
  assert.deepEqual(tries, [
    "Store manager sign-off: enter the transactions and slips counted for at least one till.",
    "Store manager sign-off: enter the slips counted for till 1.",
    "Store manager sign-off: give the reason for the difference on till 1.",
    "Store manager sign-off: tick every point of the checklist (6 still to tick).",
  ]);
  assert.match(JSON.stringify(app.stored(`cashups/${DAY}_wholesale`)), /One slip lost/);
});

test("Aeroton Retail has six tills and City Deep Retail two, each with its own fields", async t => {
  const app = await boot(t, { me: "u-admin", now: `${DAY}T16:00:00+02:00` });
  await app.tab("retail");
  assert.equal(app.all("#decl-retail .dtill").length, 6);
  for (let i = 0; i < 6; i++) for (const f of ["tx", "slips", "reason"]) assert.ok(app.has(`#dt-retail-${i}-${f}`));
  await app.tab("citydeep");
  assert.equal(app.all("#decl-citydeep .dtill").length, 2);
  await app.tab("wholesale");
  assert.equal(app.all("#decl-wholesale .dtill").length, 1);
});
