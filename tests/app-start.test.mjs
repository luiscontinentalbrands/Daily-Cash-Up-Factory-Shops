// Characterization tests: device setup, sign-in, PINs, roles, locking.
// They pin down what the app does today (odd parts included), not what it should do.
import { test } from "node:test";
import assert from "node:assert/strict";
import { boot, snap } from "./harness/boot.mjs";
import { KEY, USERS } from "./harness/fixtures.mjs";

test("no access code: setup screen", async t => {
  const app = await boot(t, { key: null });
  snap(t, app.html());
  assert.equal(app.$("#tabs").hidden, true);
  await app.type("#keyin", "1234");
  await app.submit("#keyform");
  snap(t, app.text("#keymsg"), "PIN typed instead of the code");
  await app.type("#keyin", "short-code!");
  await app.submit("#keyform");
  snap(t, app.text("#keymsg"), "invalid code");
  assert.deepEqual(app.errors(), []);
});

test("setup link stores the code and removes it from the address", async t => {
  const app = await boot(t, { key: null, hash: "#join-" + KEY });
  assert.equal(app.env.localStorage.getItem("cu_key"), KEY);
  assert.deepEqual(app.env.replaced, ["/cashup/"]);
  snap(t, app.html());
});

test("code refused or database unreachable", async t => {
  const refused = await boot(t, { before: (env, db) => { db.rejectRead = () => ({ code: "permission-denied" }); } });
  snap(t, refused.html(), "permission denied");
  assert.equal(refused.env.localStorage.getItem("cu_key"), KEY);
  t.mock.timers.reset();
  const offline = await boot(t, { before: (env, db) => { db.rejectRead = () => new Error("Failed to fetch"); } });
  snap(t, offline.html(), "offline");
});

test("who is using the app: active users only, sorted", async t => {
  const app = await boot(t);
  snap(t, app.html());
  assert.deepEqual(app.writes(), []);
});

test("first administrator", async t => {
  const app = await boot(t, { users: [] });
  snap(t, app.html(), "form");
  const msg = async () => app.text("#amsg");
  await app.type("#an", "Al");
  await app.submit("#adminform");
  snap(t, await msg(), "short name");
  await app.type("#an", "Alex Owner");
  await app.type("#ap", "12a4");
  await app.submit("#adminform");
  snap(t, await msg(), "bad pin");
  await app.type("#ap", "1234");
  await app.type("#ap2", "4321");
  await app.submit("#adminform");
  snap(t, await msg(), "pins differ");
  await app.type("#ap2", "1234");
  await app.submit("#adminform");
  snap(t, app.writes(), "writes");
  snap(t, app.html(), "app started");
  snap(t, app.html("#who"), "top bar");
  assert.equal(app.env.sessionStorage.getItem("cu_me"), "auto001");
  assert.deepEqual(app.errors(), []);
});

test("PIN entry: wrong, lockout after 5 tries (shared by all users), right", async t => {
  const app = await boot(t);
  await app.click('button[data-u="u-whole"]');
  snap(t, app.html(), "pin form");
  for (let i = 0; i < 3; i++) { await app.type("#pin", "0000"); await app.submit("#pinform"); }
  snap(t, app.text("#pinmsg"), "wrong");
  await app.click("#back");
  await app.click('button[data-u="u-retail"]');
  for (let i = 0; i < 2; i++) { await app.type("#pin", "0000"); await app.submit("#pinform"); }
  await app.type("#pin", "2468");
  await app.submit("#pinform");
  snap(t, app.text("#pinmsg"), "locked out");
  await app.advance(5 * 60000 + 1);
  await app.type("#pin", "2468");
  await app.submit("#pinform");
  assert.equal(app.env.sessionStorage.getItem("cu_me"), "u-retail");
  assert.equal(app.$('nav.tabs button[data-tab="retail"]').getAttribute("aria-selected"), "true");
  assert.deepEqual(app.errors(), []);
});

test("default tab and visible tabs per role", async t => {
  const seen = {};
  for (const u of USERS.filter(u => u.active !== false && !u.mustChange)) {
    const app = await boot(t, { me: u.id });
    seen[u.role + " " + u.name] = {
      tab: app.all("nav.tabs button").find(b => b.getAttribute("aria-selected") === "true").dataset.tab,
      users: !app.$("#tab-users").hidden, notBanked: !app.$("#tab-notbanked").hidden,
      header: app.$("header.bar").className, foot: app.text("#foot"),
    };
    t.mock.timers.reset();
  }
  snap(t, seen);
});

test("forced PIN change after the administrator set the PIN", async t => {
  const app = await boot(t);
  await app.login("Nina New", "0101");
  snap(t, app.html(), "choose PIN");
  const tryPin = async (a, b) => { await app.type("#cp1", a); await app.type("#cp2", b); await app.submit("#pinchange"); return app.has("#cpmsg") && app.text("#cpmsg"); };
  snap(t, [await tryPin("12", "12"), await tryPin("1357", "1358"), await tryPin("7777", "7777"), await tryPin("1234", "1234"), await tryPin("0101", "0101")], "rejected");
  assert.deepEqual(app.writes(), []);
  await tryPin("8642", "8642");
  snap(t, app.writes(), "saved");
  assert.equal(app.env.sessionStorage.getItem("cu_me"), "u-new");
  assert.ok(app.has("#tabs") && !app.$("#tabs").hidden);
});

test("change my PIN from the top bar", async t => {
  const app = await boot(t, { me: "u-whole" });
  await app.click("#mypin");
  snap(t, app.html(), "form");
  await app.type("#cp0", "9999");
  await app.type("#cp1", "8642");
  await app.type("#cp2", "8642");
  await app.submit("#pinchange");
  snap(t, app.text("#cpmsg"), "wrong current");
  await app.type("#cp0", "1357");
  await app.submit("#pinchange");
  snap(t, app.writes(), "saved");
  assert.ok(app.has(".deptband"));
  await app.click("#mypin");
  await app.click("#cpback");
  assert.ok(app.has(".deptband"));
});

test("switch user, switched off while signed in, idle lock", async t => {
  const app = await boot(t, { me: "u-whole" });
  await app.click("#switchu");
  snap(t, app.html(), "switch user");
  assert.equal(app.env.sessionStorage.getItem("cu_me"), null);
  await app.login("Wanda Wholesale", "1357");
  app.db.docs.get(`shops/${KEY}/users/u-whole`).active = false;
  // another device switches the user off
  const { setDoc, doc, getFirestore } = await import("./harness/fakes/firebase-firestore.mjs");
  await setDoc(doc(getFirestore(), "shops", KEY, "users", "u-whole"), { active: false }, { merge: true });
  await app.advance(0);
  snap(t, app.html(), "switched off");
  await app.login("Rita Retail", "2468");
  await app.advance(15 * 60000 - 1);
  assert.ok(app.has(".deptband"));
  await app.advance(1);
  snap(t, app.html(), "idle lock");
  assert.deepEqual(app.errors(), []);
});
