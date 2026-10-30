// Stand-in for firebase-admin, for running scripts/daily-check.mjs in a child process.
// Reads the fake database from FAKE_FIXTURE (JSON; {"__ts": iso} becomes a Timestamp)
// and, on exit, writes every database write and sent email to FAKE_OUT.
import { readFileSync, writeFileSync } from "node:fs";
import { Timestamp } from "./firebase-firestore.mjs";

const revive = v => (Array.isArray(v) ? v.map(revive) : v && typeof v === "object" ? (v.__ts ? new Timestamp(Date.parse(v.__ts)) : Object.fromEntries(Object.entries(v).map(([k, x]) => [k, revive(x)]))) : v);
const fixture = revive(JSON.parse(readFileSync(process.env.FAKE_FIXTURE, "utf8")));
const docs = new Map(Object.entries(fixture.docs || {}));
const parentOf = p => p.slice(0, p.lastIndexOf("/"));

export const out = (globalThis.__fakeOut ||= { init: null, writes: [], mails: [], transports: [] });
process.on("exit", () => writeFileSync(process.env.FAKE_OUT, JSON.stringify(out, null, 2)));

const db = {
  doc: path => ({
    get: async () => ({ exists: docs.has(path), data: () => docs.get(path) }),
    set: async (data, opts) => { out.writes.push({ path, data, opts }); },
  }),
  collection: path => ({
    where: (field, op, value) => ({
      get: async () => ({ docs: [...docs].filter(([p, d]) => parentOf(p) === path && op === "==" && d[field] === value).map(([, d]) => ({ data: () => d })) }),
    }),
  }),
};
export default {
  initializeApp(opts) { out.init = { credential: opts.credential }; },
  credential: { cert: account => ({ cert: account }) },
  firestore: () => db,
};
