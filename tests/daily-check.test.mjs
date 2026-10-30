// Characterization tests: scripts/daily-check.mjs, the 7 pm and 9 pm email job.
// Runs the real script in a child process with fake firebase-admin, nodemailer and jsPDF,
// and records every email it would send and every database write. Nothing is sent.
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { snap } from "./harness/boot.mjs";
import { KEY, DAY, PRE, SUN, at, dayDocs } from "./harness/fixtures.mjs";

const SCRIPTS = fileURLToPath(new URL("../scripts/", import.meta.url));
const HOOKS = new URL("./harness/hooks.mjs", import.meta.url).href;
const dir = mkdtempSync(path.join(tmpdir(), "daily-check-"));
let n = 0;

// Timestamps become {"__ts": iso} so the fake admin SDK can turn them back into Timestamps
const toJson = docs => JSON.parse(JSON.stringify(docs, (k, v) => (typeof v === "string" && /^<ts .+>$/.test(v) ? { __ts: v.slice(4, -1) } : v)));

function run(mode, { docs = {}, date = DAY, now = `${DAY}T19:05:00+02:00`, log, env = {} } = {}) {
  const id = ++n, fixture = path.join(dir, `in${id}.json`), out = path.join(dir, `out${id}.json`);
  const all = {};
  for (const [p, d] of Object.entries(docs)) all[`shops/${KEY}/${p}`] = d;
  if (log) all[`shops/${KEY}/emaillog/${date}`] = log;
  writeFileSync(fixture, JSON.stringify({ docs: toJson(all) }));
  const r = spawnSync(process.execPath, ["--import", HOOKS, "daily-check.mjs", ...(mode ? [mode] : [])], {
    cwd: SCRIPTS, encoding: "utf8",
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TZ: "Africa/Johannesburg", FAKE_NOW: now, FAKE_FIXTURE: fixture, FAKE_OUT: out,
      FIREBASE_SERVICE_ACCOUNT: '{"project_id":"test"}', SMTP_USER: "cashup@example.test", SMTP_PASS: "app-password", SHOP_KEY: KEY,
      ...(date ? { CASHUP_DATE: date } : {}), ...env },
  });
  const o = existsSync(out) ? JSON.parse(readFileSync(out, "utf8")) : null;
  // emails and attached PDFs one line per array entry, so a change shows up as a readable diff
  const mails = o && o.mails.map(m => ({ ...m, html: m.html.split("\n"), attachments: m.attachments.map(a => ({ ...a, content: a.content.split("\n") })) }));
  return { exit: r.status, stdout: r.stdout.trim().split("\n"), stderr: r.stderr.trim(), mails, writes: o && o.writes, transports: o && o.transports };
}

const ALL = ["wholesale", "retail", "citydeep", "manager"];
const cases = [
  ["7 pm, complete on time", "seven", { docs: dayDocs(DAY, { signed: ALL }) }],
  ["7 pm, signatures missing", "seven", { docs: dayDocs(DAY, { signed: ["wholesale", "retail"] }) }],
  ["7 pm, manager signed after 7 pm counts as missing", "seven", { docs: dayDocs(DAY, { signed: ALL, late: true }), now: `${DAY}T19:45:00+02:00` }],
  ["7 pm, nothing captured", "seven", {}],
  ["7 pm, before City Deep", "seven", { date: PRE, docs: dayDocs(PRE, { signed: ["wholesale", "retail", "manager"] }), now: `${PRE}T19:05:00+02:00` }],
  ["7 pm, City Deep sheet without its own start date", "seven", { date: PRE, docs: { ...dayDocs(PRE, { signed: ["wholesale", "retail", "manager"] }), [`cashups/${PRE}_citydeep`]: { ...dayDocs(DAY)[`cashups/${DAY}_citydeep`], date: PRE } }, now: `${PRE}T19:05:00+02:00` }],
  ["9 pm, final already sent at 7 pm", "nine", { docs: dayDocs(DAY, { signed: ALL }), log: { sentAt: "x", martieFinalSent: true }, now: `${DAY}T21:00:00+02:00` }],
  ["9 pm, completed late after an incomplete 7 pm report", "nine", { docs: dayDocs(DAY, { signed: ALL, late: true }), log: { sentAt: at(DAY, "19:05"), martieFinalSent: false }, now: `${DAY}T21:00:00+02:00` }],
  ["9 pm, complete on time but no 7 pm run", "nine", { docs: dayDocs(DAY, { signed: ALL }), now: `${DAY}T21:00:00+02:00` }],
  ["9 pm, still missing", "nine", { docs: dayDocs(DAY, { signed: ["wholesale"] }), log: { sentAt: at(DAY, "19:05") }, now: `${DAY}T21:00:00+02:00` }],
  ["9 pm, still missing and no 7 pm run", "nine", { docs: dayDocs(DAY, { signed: ["wholesale"] }), now: `${DAY}T21:00:00+02:00` }],
  ["9 pm, nothing captured and no 7 pm run", "nine", { now: `${DAY}T21:00:00+02:00` }],
  ["Sunday", "seven", { date: SUN, now: `${SUN}T19:05:00+02:00` }],
  ["delayed 9 pm run after midnight checks the day before", "nine", { date: null, docs: dayDocs(DAY, { signed: ALL }), now: "2026-10-29T00:30:00+02:00" }],
  ["no date given, daytime", "seven", { date: null, docs: dayDocs(DAY, { signed: ALL }) }],
  ["default mode is seven", null, { docs: dayDocs(DAY, { signed: ALL }) }],
  ["unknown mode", "ten", { docs: dayDocs(DAY, { signed: ALL }) }],
  ["bad date", "seven", { date: "28-10-2026" }],
  ["missing secret", "seven", { env: { SMTP_PASS: "" } }],
  ["bad shop key", "seven", { env: { SHOP_KEY: "short" } }],
  ["custom SMTP settings and recipients", "seven", { docs: dayDocs(DAY, { signed: ALL }), env: { SMTP_HOST: "smtp.example.test", SMTP_PORT: "587", MAIL_FROM: "Shop <shop@example.test>", ALERT_TO: "a@example.test", REPORT_TO: "r@example.test" } }],
];

for (const [label, mode, opts] of cases) {
  test(label, t => snap(t, run(mode, opts)));
}

test("photos are attached to the emailed PDF, removed ones left out", t => {
  const docs = {
    ...dayDocs(DAY, { signed: ALL }),
    "photos/p1": { date: DAY, dept: "retail", data: "data:image/jpeg;base64,UA==", by: "Rita Retail", takenAt: at(DAY, "16:00") },
    "photos/p2": { date: DAY, dept: "citydeep", data: "data:image/jpeg;base64,UA==", by: "Cindy Deep", takenAt: at(DAY, "15:00"), removed: true },
    "photos/p3": { date: DAY, dept: "citydeep", data: "data:image/jpeg;base64,UQ==", by: "Cindy Deep", takenAt: at(DAY, "15:30") },
  };
  const r = run("seven", { docs });
  snap(t, r.mails.map(m => m.attachments.map(a => a.content.filter(l => /till report photo|addImage/.test(l)))));
});
