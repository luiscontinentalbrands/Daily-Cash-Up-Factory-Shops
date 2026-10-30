// Characterization tests: the Not banked report (CashGuard retained and petty cash), Banked ticks, CSV, PDF.
import { test } from "node:test";
import assert from "node:assert/strict";
import { boot, snap } from "./harness/boot.mjs";
import { DAY, PRE, at, dayDocs, ts } from "./harness/fixtures.mjs";

const docs = () => ({
  ...dayDocs(PRE, { signed: ["wholesale", "retail", "manager"] }),
  ...dayDocs(DAY, { signed: ["retail"] }),
  ...dayDocs("2026-10-27"),
  // a tick for the retail CashGuard on PRE, a tick whose amount no longer matches, and a petty cash tick
  [`banked/${PRE}_retail`]: { date: PRE, shop: "retail", amount: 300, banked: true, by: "Ada Admin", at: ts(at(DAY, "09:00")), atIso: at(DAY, "09:00") },
  [`banked/${DAY}_citydeep`]: { date: DAY, shop: "citydeep", amount: 99, banked: true, by: "Ada Admin", atIso: at(DAY, "09:30") },
  [`banked/2026-10-27_retailpetty`]: { date: "2026-10-27", shop: "retailpetty", amount: 200, banked: false, by: "Ada Admin", atIso: at(DAY, "09:45") },
  "handovers/h1": { date: PRE, shop: "retail", amount: 300, givenBy: "Rita Retail", receivedBy: "Candido", signature: "data:image/png;base64,SA==", atIso: at(PRE, "17:30") },
  "handovers/h2": { date: DAY, shop: "retail", amount: 120.5, givenBy: "Rita Retail", receivedBy: "Candido", signature: "x", atIso: at(DAY, "17:30") },
});

test("only managers and the administrator", async t => {
  const app = await boot(t, { me: "u-whole" });
  await app.tab("notbanked");
  snap(t, app.html());
});

test("report for a date range, hide banked, tick and untick", async t => {
  const app = await boot(t, { me: "u-admin", docs: docs(), now: `${DAY}T12:00:00+02:00` });
  await app.tab("notbanked");
  snap(t, app.html(), "before loading");
  await app.type("#nbfrom", "2026-10-29");
  await app.type("#nbto", "2026-10-01");
  await app.submit("#nbform");
  snap(t, app.html(), "dates swapped, loaded");
  await app.click("#nbhide");
  snap(t, app.html("tbody"), "banked hidden");
  await app.click("#nbhide");
  const boxes = app.all(".nbtick");
  await app.click(boxes[boxes.length - 1]);
  snap(t, app.writes(), "tick");
  snap(t, app.text("#nb-msg"), "tick message");
  app.env.confirmAnswers.push(false);
  await app.click(app.all(".nbtick")[0]);
  snap(t, { confirm: app.env.confirms, writes: app.writes(), checked: app.all(".nbtick")[0].checked }, "untick cancelled");
  await app.click(app.all(".nbtick")[0]);
  snap(t, app.writes(), "untick");
  app.db.rejectWrite = () => ({ code: "permission-denied" });
  await app.click(app.all(".nbtick")[1]);
  snap(t, [app.text("#nb-msg"), app.all(".nbtick")[1].checked], "tick refused");
});

test("manager sees the report but cannot tick; invalid dates; empty period", async t => {
  const app = await boot(t, { me: "u-mgr", docs: docs(), now: `${DAY}T12:00:00+02:00` });
  await app.tab("notbanked");
  await app.submit("#nbform");
  snap(t, app.html(".tbl-wrap"), "manager");
  assert.ok(app.all(".nbtick").every(b => b.disabled));
  await app.type("#nbfrom", "");
  await app.submit("#nbform");
  snap(t, app.html(".sheet-body .msg.err"), "invalid");
  await app.type("#nbfrom", "2026-09-01");
  await app.type("#nbto", "2026-09-30");
  await app.submit("#nbform");
  snap(t, app.text(".empty-state"), "nothing");
});

test("Not banked CSV and PDF, and opening a day from the table", async t => {
  const d = docs();
  d[`cashups/${DAY}_retail`].pettyNotes = '=1+1, "petty"';
  const app = await boot(t, { me: "u-admin", docs: d, now: `${DAY}T12:00:00+02:00` });
  await app.tab("notbanked");
  await app.submit("#nbform");
  await app.click("#nb-csv");
  snap(t, [app.env.downloads[0].name, await app.env.downloads[0].blob.text()], "csv");
  await app.click("#nb-pdf");
  snap(t, [app.env.downloads[1].name, await app.env.downloads[1].blob.text(), app.text("#nb-msg")], "pdf");
  const cdRow = app.all(".nbrow").find(r => r.dataset.shop === "citydeep");
  await app.click(cdRow);
  assert.equal(app.$("#date").value, cdRow.dataset.d);
  assert.equal(app.$('nav.tabs button[data-tab="citydeep"]').getAttribute("aria-selected"), "true");
  await app.tab("notbanked");
  await app.click(app.all(".nbrow").find(r => r.dataset.shop === "retail"));
  assert.equal(app.$('nav.tabs button[data-tab="combined"]').getAttribute("aria-selected"), "true");
  await app.tab("notbanked");
  await app.click(app.all(".nbbank")[0]);
  assert.equal(app.$('nav.tabs button[data-tab="notbanked"]').getAttribute("aria-selected"), "true", "the Banked cell does not open the day");
});

test("report load errors", async t => {
  const app = await boot(t, { me: "u-admin", docs: docs(), now: `${DAY}T12:00:00+02:00` });
  await app.tab("notbanked");
  app.db.rejectRead = q => (q.path.endsWith("/banked") || q.path.endsWith("/handovers") ? new Error("nope") : null);
  await app.submit("#nbform");
  snap(t, app.html(".tbl-wrap"), "ticks and handovers missing");
  app.db.rejectRead = () => ({ code: "unavailable" });
  await app.submit("#nbform");
  snap(t, app.html(".sheet-body"), "failed");
});
