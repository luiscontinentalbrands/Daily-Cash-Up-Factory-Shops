// Characterization tests: report photos, the AI photo reader, attached PDFs, and the Aeroton cash handover.
import { test } from "node:test";
import assert from "node:assert/strict";
import { boot, snap } from "./harness/boot.mjs";
import { DAY, PHOTO, at, dayDocs } from "./harness/fixtures.mjs";

const jpg = (name = "report.jpg", meta) => Object.assign(new File(["x"], name, { type: "image/jpeg" }), meta ? { __img: meta } : {});
const reply = text => { globalThis.__fakeAI.reply = () => text; };

test("scan a photo: saved, figures filled (Wholesale), checks against total and date", async t => {
  const app = await boot(t, { me: "u-whole" });
  reply('```json\n{"Cash": "R 1 234,56", "cashguard": 2000, "Credit Card": "1,480.50", "CBM": 10, "payfast": "99,9", "eft": null, "shop2shop": 5, "snapscan": "abc", "total": 9999, "date": "2026-10-27", "readable": true}\n```');
  await app.files("#wholesale-photo", [jpg()]);
  snap(t, app.writes(), "writes");
  snap(t, globalThis.__fakeAI.attempts, "AI attempts");
  snap(t, globalThis.__fakeAI.prompts[0], "prompt");
  snap(t, app.html("#scan-msg"), "message");
  snap(t, app.html("tbody"), "rows");
  await app.advance(700);
  snap(t, app.writes(), "sheet saved with aiFill");
  assert.equal(app.env.localStorage.getItem("cu_airoute"), '{"r":"vertex-global","m":"gemini-3.5-flash"}');
});

test("photo reader on the retail shops: EFT counted as card, prompt wording", async t => {
  const app = await boot(t, { me: "u-retail" });
  reply('{"cash": 10, "card": 100, "eft": 50.5, "snapscan": null, "total": 160.5, "date": "2026-10-28", "readable": true}');
  await app.files("#retail-photo", [jpg()]);
  snap(t, app.html("#scan-msg"), "message");
  snap(t, [app.$("#retail-card-report").value, app.$("#retail-cash-report").value], "card and coins");
  snap(t, globalThis.__fakeAI.prompts[0], "retail prompt");
  t.mock.timers.reset();
  const cd = await boot(t, { me: "u-cd" });
  reply('{"readable": false}');
  await cd.files("#citydeep-photo", [jpg()]);
  snap(t, cd.text("#scan-msg"), "unreadable");
  snap(t, globalThis.__fakeAI.prompts[0], "city deep prompt");
});

test("photo reader: remembered route first, fallbacks, and every error message", async t => {
  const messages = {};
  const errors = {
    "app check": "AppCheck: App Check token is invalid",
    "genai config": "Firebase AI: genai config not found",
    "not enabled": "API has not been used in project 123 before or it is disabled. SERVICE_DISABLED",
    "no model": "404 model not found",
    "quota": "429 RESOURCE_EXHAUSTED: quota exceeded",
    "quota mentioning a model": "429 RESOURCE_EXHAUSTED: Quota exceeded for model gemini-3.5-flash",
    "key": "API key not valid: referer blocked",
    "network": "Failed to fetch",
    "other": "Something odd",
  };
  for (const [label, text] of Object.entries(errors)) {
    const app = await boot(t, { me: "u-whole", local: label === "app check" ? { cu_airoute: '{"r":"google","m":"gemini-2.5-flash"}' } : {} });
    globalThis.__fakeAI.reply = () => { throw new Error(text); };
    await app.files("#wholesale-photo", [jpg()]);
    messages[label] = { message: app.text("#scan-msg"), tried: globalThis.__fakeAI.attempts.map(a => `${a.route} ${a.model}`) };
    t.mock.timers.reset();
  }
  snap(t, messages);
});

test("photo reader: an unknown model moves on to the next model", async t => {
  const app = await boot(t, { me: "u-whole" });
  globalThis.__fakeAI.reply = a => { if (a.model !== "gemini-3.1-flash-lite") throw new Error("404 model not found"); return '{"cash": 5, "readable": true}'; };
  await app.files("#wholesale-photo", [jpg()]);
  snap(t, { tried: globalThis.__fakeAI.attempts.map(a => `${a.route} ${a.model}`), remembered: app.env.localStorage.getItem("cu_airoute"), message: app.text("#scan-msg") });
});

test("photos: add another (no reading), unreadable file, big photo is shrunk, strip, enlarge, remove", async t => {
  const app = await boot(t, { me: "u-whole" });
  await app.files("#wholesale-photo2", [jpg("second.jpg", { w: 4000, h: 3000 })]);
  snap(t, { writes: app.writes(), message: app.text("#scan-msg"), ai: globalThis.__fakeAI.attempts.length }, "added without reading");
  await app.files("#wholesale-photo2", [jpg("broken.jpg", { broken: true })]);
  snap(t, app.text("#scan-msg"), "broken");
  snap(t, app.html('[data-photos="wholesale"]'), "strip");
  await app.click("button.thumb");
  const overlay = app.doc.body.children.at(-1);
  snap(t, app.html(overlay), "enlarged");
  await app.click(overlay);
  assert.ok(!overlay.isConnected);
});

test("removing a photo clears the figures read from it", async t => {
  const docs = {
    ...dayDocs(DAY),
    "photos/p1": { date: DAY, dept: "wholesale", data: PHOTO, by: "Wanda Wholesale", takenAt: at(DAY, "09:00") },
    "photos/p2": { date: DAY, dept: "wholesale", data: PHOTO, by: "Wanda Wholesale", takenAt: at(DAY, "09:05"), removed: true, removedBy: "Wanda Wholesale", removedAtIso: at(DAY, "09:06") },
  };
  docs[`cashups/${DAY}_wholesale`].aiFill = { p1: { cash: "1500.00", card: "3200.50" } };
  const app = await boot(t, { me: "u-whole", docs });
  snap(t, app.html('[data-photos="wholesale"]'), "strip with removed note");
  await app.click('button[data-rm="p1"]');
  snap(t, app.text('button[data-rm="p1"]'), "armed");
  await app.click('button[data-rm="p1"]');
  snap(t, { writes: app.writes(), message: app.text("#scan-msg"), cash: app.$("#wholesale-cash-report").value, card: app.$("#wholesale-card-report").value, cashguard: app.$("#wholesale-cashguard-report").value }, "removed");
  await app.advance(700);
  snap(t, app.writes(), "sheet saved");
});

test("removing the last old photo (nothing recorded) clears the whole report column; re-reading a photo", async t => {
  const docs = { ...dayDocs(DAY), "photos/p1": { date: DAY, dept: "wholesale", data: PHOTO, by: "Wanda Wholesale", takenAt: at(DAY, "09:00") } };
  const app = await boot(t, { me: "u-whole", docs });
  reply('{"cash": 1, "readable": true}');
  await app.click('button[data-read="p1"]');
  snap(t, app.text("#scan-msg"), "read again");
  app.db.rejectWrite = (op, path) => (path.includes("/photos/") ? new Error("offline") : null);
  await app.click('button[data-rm="p1"]');
  await app.click('button[data-rm="p1"]');
  snap(t, app.text('button[data-rm="p1"]'), "could not remove");
  app.db.rejectWrite = null;
  // still armed after the failure: one more tap removes it
  await app.click('button[data-rm="p1"]');
  snap(t, [...app.all("td.inp input")].map(i => `${i.id}=${i.value}`), "all report boxes");
});

test("attach files: PDF pages kept, figures read from the last page; other files refused", async t => {
  const app = await boot(t, { me: "u-whole" });
  reply('{"cash": 42, "readable": true}');
  app.env.pdfPages = 8;
  await app.files("#wholesale-file", [new File(["%PDF"], "z-report.pdf", { type: "application/pdf" })]);
  snap(t, { writes: app.writes().map(w => [w.path, w.data.takenAt, w.data.data.slice(0, 60)]), message: app.text("#scan-msg"), ai: globalThis.__fakeAI.attempts.length }, "pdf");
  await app.files("#wholesale-file", [new File(["x"], "notes.txt", { type: "text/plain" })]);
  snap(t, app.text("#scan-msg"), "text file");
  await app.files("#wholesale-file", [jpg("a.jpg"), new File(["%PDF"], "b.pdf", { type: "application/pdf" })]);
  snap(t, app.writes().map(w => w.path), "photo then pdf");
  // a photo is 1200 x 1600; a PDF page comes out 1272 x 1800: the figures are read from the PDF's last page
  snap(t, globalThis.__fakeAI.images, "pictures read");
  app.env.loadScript = sc => queueMicrotask(() => sc.onerror());
  app.env.window.pdfjsLib = null;
  t.mock.timers.reset();
  const noPdf = await boot(t, { me: "u-whole" });
  noPdf.env.loadScript = sc => queueMicrotask(() => sc.onerror());
  await noPdf.files("#wholesale-file", [new File(["%PDF"], "c.pdf", { type: "application/pdf" })]);
  snap(t, noPdf.text("#scan-msg"), "pdf reader unavailable");
});

test("Aeroton cash handover: section, checks, signed for", async t => {
  const app = await boot(t, { me: "u-retail", docs: dayDocs(DAY) });
  snap(t, app.html("#ho-sec"), "section");
  const sign = async () => { await app.click("#ho-sign"); return app.text("#ho-msg"); };
  await app.type("#ho-amt", "");
  const out = [await sign()];
  await app.type("#ho-amt", "1 2a3,4");
  await app.blur("#ho-amt");
  out.push(app.$("#ho-amt").value);
  await app.type("#ho-to", "Ca");
  out.push(await sign());
  await app.type("#ho-to", " rita retail ");
  out.push(await sign());
  await app.type("#ho-to", "Candido");
  out.push(await sign());
  snap(t, out, "checks");
  await app.draw("#hpad");
  await app.type("#ho-note", "envelope sealed");
  await sign();
  snap(t, { writes: app.writes(), message: app.text("#ho-msg"), list: app.html("#ho-list") }, "signed for");
  app.db.rejectWrite = () => ({ code: "permission-denied" });
  await app.draw("#hpad");
  snap(t, await sign(), "refused");
  await app.click("#ho-clear");
  t.mock.timers.reset();
  const viewer = await boot(t, { me: "u-whole", docs: dayDocs(DAY) });
  await viewer.tab("retail");
  snap(t, viewer.html("#ho-sec"), "view only");
});
