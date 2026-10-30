// Characterization tests: the History tab and the administrator's Users tab.
import { test } from "node:test";
import assert from "node:assert/strict";
import { boot, snap } from "./harness/boot.mjs";
import { DAY, PRE, SUN, dayDocs } from "./harness/fixtures.mjs";

test("History: days newest first, status and totals; tap a day to open End of Day", async t => {
  const docs = {
    ...dayDocs(PRE, { signed: ["wholesale", "retail", "manager"] }),
    ...dayDocs("2026-10-26", { signed: ["wholesale", "retail", "citydeep", "manager"], late: true }),
    ...dayDocs("2026-10-27", { signed: ["wholesale"] }),
    ...dayDocs(DAY),
    [`cashups/${SUN}_wholesale`]: dayDocs(SUN)[`cashups/${SUN}_wholesale`],
  };
  const app = await boot(t, { me: "u-whole", docs, now: `${DAY}T20:00:00+02:00` });
  await app.tab("history");
  snap(t, app.html());
  await app.click('.hrow[data-d="2026-10-27"]');
  assert.equal(app.$("#date").value, "2026-10-27");
  assert.equal(app.$('nav.tabs button[data-tab="combined"]').getAttribute("aria-selected"), "true");
  t.mock.timers.reset();
  const empty = await boot(t, { me: "u-whole" });
  await empty.tab("history");
  snap(t, empty.html(), "empty");
});

test("History with more sheets than it loads: the oldest day is not shown half loaded", async t => {
  const docs = {};
  for (let i = 0; i < 90; i++) {
    const date = new Date(Date.UTC(2026, 9, 28 - i)).toISOString().slice(0, 10);
    Object.assign(docs, dayDocs(date, { signed: ["wholesale", "retail", "citydeep", "manager"] }));
  }
  // one extra sheet, so the 240 loaded end part-way through a day
  docs["cashups/2026-10-10_citydeep"] = { ...dayDocs(DAY)[`cashups/${DAY}_citydeep`], date: "2026-10-10" };
  const app = await boot(t, { me: "u-whole", docs, now: `${DAY}T20:00:00+02:00` });
  await app.tab("history");
  const rows = app.all(".hrow");
  snap(t, { days: rows.length, oldest: rows.slice(-2).map(r => r.textContent.replace(/\s+/g, " ").trim()) });
});

test("Users: only the administrator; the list", async t => {
  const app = await boot(t, { me: "u-mgr" });
  await app.tab("users");
  assert.equal(app.$('nav.tabs button[data-tab="wholesale"]').getAttribute("aria-selected"), "true");
  t.mock.timers.reset();
  const admin = await boot(t, { me: "u-admin" });
  await admin.tab("users");
  snap(t, admin.html());
});

test("Users: add a user (checks), switch off, new PIN", async t => {
  const app = await boot(t, { me: "u-admin" });
  await app.tab("users");
  const add = async (name, role, pin) => { await app.type("#un", name); await app.choose("#ur", role); await app.type("#up", pin); await app.submit("#uform"); return app.text("#umsg"); };
  snap(t, [await add("Jo", "wholesale", "1234"), await add(" rita retail ", "retail", "1234"), await add("Sam Smith", "retail", "12")], "rejected");
  await add("Sam Smith", "citydeep", "4321");
  snap(t, { writes: app.writes(), message: app.text("#umsg"), name: app.$("#un").value }, "added");
  await app.click('button[data-act="toggle"][data-u="u-whole"]');
  snap(t, app.writes(), "switched off");
  await app.click('button[data-act="pin"][data-u="u-retail"]');
  snap(t, app.html('form[data-pinfor="u-retail"]'), "new PIN form");
  const f = app.$('form[data-pinfor="u-retail"]');
  await app.type(f.querySelector("input"), "12");
  await app.submit(f);
  snap(t, app.text("#umsg"), "bad PIN");
  await app.type(f.querySelector("input"), "9753");
  await app.submit(f);
  snap(t, { writes: app.writes(), message: app.text("#umsg"), formGone: !app.has('form[data-pinfor="u-retail"]') }, "new PIN saved");
  app.db.rejectWrite = () => new Error("offline");
  await add("Pat Jones", "manager", "1111");
  await app.click('button[data-act="toggle"][data-u="u-cd"]');
  snap(t, app.text("#umsg"), "save failures");
});

test("Users: delete asks first, keeps the last administrator", async t => {
  const app = await boot(t, { me: "u-admin", users: [
    { id: "u-admin", name: "Ada Admin", role: "admin", pin: "2580" },
    { id: "u-admin2", name: "Bea Backup", role: "admin", pin: "2581", active: false },
    { id: "u-whole", name: "Wanda Wholesale", role: "wholesale", pin: "1357" },
  ] });
  await app.tab("users");
  await app.click('button[data-act="del"][data-u="u-admin2"]');
  snap(t, { confirms: app.env.confirms, writes: app.writes() }, "inactive admin deleted");
  app.env.confirmAnswers.push(false);
  await app.click('button[data-act="del"][data-u="u-whole"]');
  snap(t, { confirms: app.env.confirms.slice(1), writes: app.writes() }, "cancelled");
  await app.click('button[data-act="del"][data-u="u-whole"]');
  snap(t, { writes: app.writes(), message: app.text("#umsg"), list: app.text(".hist") }, "deleted");
});

test("Users: another administrator can be deleted while you are one (the last-administrator check never triggers)", async t => {
  const app = await boot(t, { me: "u-admin", users: [
    { id: "u-admin", name: "Ada Admin", role: "admin", pin: "2580" },
    { id: "u-admin2", name: "Bea Backup", role: "admin", pin: "2581" },
  ] });
  await app.tab("users");
  await app.click('button[data-act="del"][data-u="u-admin2"]');
  snap(t, { message: app.text("#umsg"), confirms: app.env.confirms, writes: app.writes() });
  assert.ok(!app.has('button[data-act="del"][data-u="u-admin"]'), "no delete button for yourself");
});
