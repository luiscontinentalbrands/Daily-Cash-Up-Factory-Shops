// Starts a fresh copy of app.js against the fake browser and fake Firestore, and returns
// a driver for clicking, typing and reading what is on screen.
import "./hooks.mjs";
import path from "node:path";
import { snapshot } from "node:test";
import { installBrowser, settle } from "./env.mjs";
import { fire, pretty } from "./dom.mjs";
import { __reset, describe } from "./fakes/firebase-firestore.mjs";
import { KEY, DAY, USERS, userDocs } from "./fixtures.mjs";

snapshot.setDefaultSnapshotSerializers([v => (typeof v === "string" ? v : JSON.stringify(v, null, 2))]);
snapshot.setResolveSnapshotPath(file => path.join(path.dirname(file), "__snapshots__", path.basename(file) + ".snapshot"));

export { settle };
let run = 0;

export async function boot(t, { now = `${DAY}T10:00:00+02:00`, key = KEY, me, hash = "", users = USERS, docs = {}, local = {}, before } = {}) {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: Date.parse(now) });
  const env = installBrowser({ hash });
  const db = __reset();
  globalThis.__fakeAI = { attempts: [], prompts: [], reply: () => { throw new Error("no AI reply scripted"); } };
  for (const [p, d] of Object.entries({ ...(await userDocs(users)), ...docs })) db.docs.set(`shops/${KEY}/${p}`, d);
  if (key) env.localStorage.setItem("cu_key", key);
  for (const [k, v] of Object.entries(local)) env.localStorage.setItem(k, v);
  if (me) env.sessionStorage.setItem("cu_me", me);
  if (before) before(env, db);
  await import(new URL(`../../app.js?run=${++run}`, import.meta.url).href);
  await settle();
  return driver(t, env, db);
}

function driver(t, env, db) {
  const doc = env.document;
  const $ = sel => {
    const el = typeof sel === "string" ? doc.querySelector(sel) : sel;
    if (!el) throw new Error("Not on screen: " + sel);
    return el;
  };
  const d = {
    env, db, doc, $,
    has: sel => !!doc.querySelector(sel),
    all: sel => doc.querySelectorAll(sel),
    html: (sel = "#main") => pretty($(sel)).join("\n"),
    text: (sel = "#main") => $(sel).textContent.replace(/[ \t\n\r]+/g, " ").trim(),
    async click(sel) {
      // The end-of-day manager declaration must be ticked before a shop sheet can be signed. Tests written before
      // it existed sign straight away, so tick it first unless the test turned this off to test the declaration.
      if (sel === "#signbtn" && d.autoDeclare !== false) await d.declare();
      env.userClick($(sel)); await settle();
    },
    // tick every point of the end-of-day manager declaration on screen
    async declare() {
      // first till used: 3 transactions, 3 slips (other tills left blank, as when not used)
      const fill = { tx: "3", slips: "3" };
      for (const el of doc.querySelectorAll('.decl input[data-till="0"]')) {
        if (!el.disabled && el.value === "" && fill[el.dataset.f] != null) { el.value = fill[el.dataset.f]; fire(el, "input"); }
      }
      for (const cb of doc.querySelectorAll(".decl input[data-decl]")) {
        if (!cb.checked && !cb.disabled) { cb.checked = true; fire(cb, "change"); }
      }
      await settle();
    },
    async type(sel, value) {
      const el = $(sel);
      if (doc.activeElement !== el) doc._focus(el);
      fire(el, "keydown", { key: "0" });
      el.value = value;
      fire(el, "input");
      await settle();
    },
    async blur(sel) { const el = $(sel); if (doc.activeElement === el) doc._focus(null); else fire(el, "blur", {}, false); await settle(); },
    async choose(sel, value) { const el = $(sel); el.value = value; fire(el, "change"); await settle(); },
    async submit(sel) { fire($(sel), "submit"); await settle(); },
    async draw(sel) {
      const el = $(sel);
      fire(el, "pointerdown", { pointerId: 1, clientX: 10, clientY: 10 });
      fire(el, "pointermove", { pointerId: 1, clientX: 40, clientY: 25 });
      fire(el, "pointerup", { pointerId: 1 });
      await settle();
    },
    async files(sel, files) { const el = $(sel); el.files = files; fire(el, "change"); await settle(); },
    async tab(name) { await d.click(`nav.tabs button[data-tab="${name}"]`); },
    async date(value) { const el = $("#date"); el.value = value; fire(el, "change"); await settle(); },
    async advance(ms) { t.mock.timers.tick(ms); await settle(); },
    async login(name, pin) { await d.click(`button[data-u="${USERS.find(u => u.name === name).id}"]`); await d.type("#pin", pin); await d.submit("#pinform"); },
    // database writes since the last call, with server timestamps shown as <serverTimestamp>
    writes() { return db.writes.splice(0); },
    stored(p) { return describe(db.docs.get(`shops/${KEY}/${p}`)); },
    errors() { return [...env.errors, ...db.errors].map(e => String((e && e.stack) || e)); },
  };
  return d;
}

// t.assert.snapshot with an optional label shown at the top of the stored value
export const snap = (t, value, label) =>
  t.assert.snapshot(label ? `## ${label}\n${typeof value === "string" ? value : JSON.stringify(value, null, 2)}` : value);
