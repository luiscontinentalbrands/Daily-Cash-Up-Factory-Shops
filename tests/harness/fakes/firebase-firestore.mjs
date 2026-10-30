// In-memory stand-in for the Firestore web SDK functions that app.js imports.
// Tests reach the data through __reset() / __backend(): docs, live listeners, a log of writes,
// and hooks to make reads, writes or listeners fail.

export class Timestamp {
  constructor(ms) { this.ms = ms; }
  toDate() { return new Date(this.ms); }
  toJSON() { return `<ts ${new Date(this.ms).toISOString()}>`; }
}
const SERVER_TIME = Object.freeze({ __serverTimestamp: true });

let B = null;
export function __reset() {
  B = { docs: new Map(), listeners: new Set(), writes: [], errors: [], nextId: 0, rejectWrite: null, rejectRead: null, rejectListen: null };
  return B;
}
export const __backend = () => B;

const isObj = v => v && typeof v === "object" && !(v instanceof Timestamp) && v !== SERVER_TIME;
const map = (v, f) => (Array.isArray(v) ? v.map(x => map(x, f)) : isObj(v) ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, map(x, f)])) : f(v));
const clone = v => map(v, x => x);
export const describe = v => map(v, x => (x === SERVER_TIME ? "<serverTimestamp>" : x instanceof Timestamp ? x.toJSON() : x));
const hasUndefined = v => (Array.isArray(v) ? v.some(hasUndefined) : isObj(v) ? Object.values(v).some(hasUndefined) : v === undefined);
const merge = (a, b) => { const o = { ...a }; for (const [k, v] of Object.entries(b)) o[k] = isObj(v) && isObj(a[k]) ? merge(a[k], v) : v; return o; };
const parentOf = p => p.slice(0, p.lastIndexOf("/"));

export function getFirestore(app) { return { __db: true, app }; }
export function collection(parent, ...segs) { return { type: "collection", path: [...(parent.__db ? [] : [parent.path]), ...segs].join("/") }; }
export function doc(parent, ...segs) {
  const path = parent.__db ? segs.join("/") : parent.path + "/" + (segs.length ? segs.join("/") : "auto" + String(++B.nextId).padStart(3, "0"));
  return { type: "doc", path, id: path.split("/").pop() };
}
export const serverTimestamp = () => SERVER_TIME;
export const where = (field, op, value) => ({ kind: "where", field, op, value });
export const orderBy = (field, dir = "asc") => ({ kind: "orderBy", field, dir });
export const limit = n => ({ kind: "limit", n });
export const query = (ref, ...cs) => ({ type: "query", path: ref.path, cs });

const OPS = { "==": (a, b) => a === b, ">=": (a, b) => a >= b, "<=": (a, b) => a <= b, "<": (a, b) => a < b, ">": (a, b) => a > b };
function run(q) {
  const cs = q.cs || [];
  let rows = [...B.docs].filter(([p]) => parentOf(p) === q.path).map(([path, d]) => ({ id: path.split("/").pop(), path, d }));
  for (const c of cs) if (c.kind === "where") rows = rows.filter(r => r.d[c.field] !== undefined && OPS[c.op](r.d[c.field], c.value));
  const order = cs.filter(c => c.kind === "orderBy"), ineq = cs.find(c => c.kind === "where" && c.op !== "==");
  if (!order.length && ineq) order.push({ field: ineq.field, dir: "asc" });
  rows = rows.filter(r => order.every(o => r.d[o.field] !== undefined));
  rows.sort((a, b) => {
    for (const o of order) { const x = a.d[o.field], y = b.d[o.field]; if (x !== y) return (x < y ? -1 : 1) * (o.dir === "desc" ? -1 : 1); }
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  const lim = cs.find(c => c.kind === "limit");
  return lim ? rows.slice(0, lim.n) : rows;
}
const snap = rows => {
  const docs = rows.map(r => ({ id: r.id, ref: { path: r.path, id: r.id }, data: () => clone(r.d) }));
  return { docs, size: docs.length, empty: !docs.length };
};
function deliver(l) {
  const rows = run(l.q), key = JSON.stringify(rows.map(r => [r.path, describe(r.d)]));
  if (key === l.last) return;
  l.last = key;
  try { l.next(snap(rows)); } catch (e) { B.errors.push(e); }
}

export function onSnapshot(q, next, error) {
  const b = B, l = { q, next, last: null }, err = b.rejectListen && b.rejectListen(q);
  if (!err) b.listeners.add(l);
  queueMicrotask(() => { if (b !== B) return; if (err) { if (error) error(err); } else if (b.listeners.has(l)) deliver(l); });
  return () => b.listeners.delete(l);
}
export async function getDocs(q) {
  const err = B.rejectRead && B.rejectRead(q);
  await null;
  if (err) throw err;
  return snap(run(q));
}

async function write(op, ref, data, mergeIt) {
  const b = B, err = (b.rejectWrite && b.rejectWrite(op, ref.path, data)) || (hasUndefined(data) ? new Error(`Function ${op}() called with invalid data. Unsupported field value: undefined`) : null);
  b.writes.push({ op, path: ref.path, ...(mergeIt ? { merge: true } : {}), data: describe(data), ...(err ? { rejected: err.code || err.message } : {}) });
  await null;
  if (err) throw err;
  const val = map(data, x => (x === SERVER_TIME ? new Timestamp(Date.now()) : x));
  if (op === "update") {
    if (!b.docs.has(ref.path)) throw Object.assign(new Error("No document to update"), { code: "not-found" });
    b.docs.set(ref.path, { ...b.docs.get(ref.path), ...val });
  } else b.docs.set(ref.path, mergeIt && b.docs.has(ref.path) ? merge(b.docs.get(ref.path), val) : val);
  for (const l of [...b.listeners]) deliver(l);
  await null;
}
export const setDoc = (ref, data, opts) => write("set", ref, data, !!(opts && opts.merge));
export const updateDoc = (ref, data) => write("update", ref, data);
export async function addDoc(col, data) { const ref = doc(col); await write("add", ref, data); return ref; }
