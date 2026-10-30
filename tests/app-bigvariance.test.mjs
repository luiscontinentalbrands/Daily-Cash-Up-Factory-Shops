// The big red alert: a payment line more than R1000 out must be checked before the sheet is signed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { boot, snap } from "./harness/boot.mjs";
import { DAY, dayDocs } from "./harness/fixtures.mjs";

const alertOpen = app => app.has(".bigalert");

test("rows more than R1000 out are marked red while typing; exactly R1000 is not", async t => {
  const app = await boot(t, { me: "u-whole" });
  await app.type("#wholesale-cash-report", "2000");
  await app.type("#wholesale-cash-deposited", "1000");
  assert.ok(!app.$("#v-cash").parentElement.classList.contains("bigvar"), "exactly R1000");
  await app.type("#wholesale-cash-deposited", "999.99");
  assert.ok(app.$("#v-cash").parentElement.classList.contains("bigvar"), "R1000.01 short");
  await app.type("#wholesale-card-deposited", "1500");
  snap(t, app.all("tbody tr").map(r => `${r.className || "-"} ${r.children[0].textContent.trim()}`), "rows");
  await app.type("#wholesale-cash-deposited", "2000");
  assert.ok(!app.$("#v-cash").parentElement.classList.contains("bigvar"), "fixed");
});

test("signing with a big difference: sent back to check first, then asked to confirm", async t => {
  const app = await boot(t, { me: "u-retail" });
  await app.type("#retail-cashguard-report", "5000");
  await app.type("#retail-cashguard-deposited", "3000");
  await app.type("#retail-cashguard-retained", "500");
  await app.type("#retail-card-report", "100");
  await app.type("#retail-card-deposited", "100");
  await app.type("#retail-petty-deposited", "5000");
  await app.advance(700);
  app.writes();
  await app.draw("#pad");
  await app.click("#signbtn");
  assert.ok(alertOpen(app));
  snap(t, app.html(".bigalert"), "first alert");
  assert.equal(app.doc.activeElement, app.$("#bigalert-back"));
  await app.click("#bigalert-back");
  assert.ok(!alertOpen(app));
  assert.equal(app.doc.activeElement, app.$("#retail-cashguard-report"), "taken to the figure to check");
  snap(t, app.text("#sign-msg"), "message after going back");
  assert.deepEqual(app.writes(), [], "not signed");
  await app.click("#signbtn");
  snap(t, app.html(".bigalert"), "second alert");
  await app.click("#bigalert-sign");
  assert.ok(!alertOpen(app));
  snap(t, app.writes().map(w => [w.op, w.path, w.data.status || w.data.action]), "signed");
});

test("changing the figures after going back asks to check again; Escape goes back too", async t => {
  const app = await boot(t, { me: "u-cd" });
  await app.type("#citydeep-card-report", "3000");
  await app.type("#citydeep-card-deposited", "100");
  await app.draw("#pad");
  await app.click("#signbtn");
  await app.click("#bigalert-back");
  await app.type("#citydeep-card-deposited", "200");
  await app.click("#signbtn");
  snap(t, app.text("#bigalert-title"), "new difference: check again");
  const { fire } = await import("./harness/dom.mjs");
  fire(app.$(".bigalert"), "keydown", { key: "Escape" });
  await app.advance(0);
  assert.ok(!alertOpen(app));
  await app.click("#signbtn");
  snap(t, app.text("#bigalert-title"), "same difference: confirm");
});

test("no alert without a big difference, and none for the manager's sign-off", async t => {
  const app = await boot(t, { me: "u-whole", docs: dayDocs(DAY) });
  await app.draw("#pad");
  await app.click("#signbtn");
  assert.ok(!alertOpen(app));
  assert.equal(app.text(".sheet.wholesale .chip"), "Signed off");
  t.mock.timers.reset();
  const docs = dayDocs(DAY, { signed: ["wholesale", "retail", "citydeep"] });
  docs[`cashups/${DAY}_wholesale`].lines.cash = { report: "5000.00", deposited: "100.00" };
  const mgr = await boot(t, { me: "u-mgr", docs, now: `${DAY}T18:00:00+02:00` });
  await mgr.draw("#pad");
  await mgr.click("#signbtn");
  assert.ok(!alertOpen(mgr));
  assert.match(mgr.text(".sheet:last-child .chip"), /Signed off/);
});
