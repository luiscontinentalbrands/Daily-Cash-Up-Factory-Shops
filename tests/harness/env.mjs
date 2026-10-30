// Installs a fake browser (document, window, storage, location, canvas, downloads…) as Node globals.
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { Document, Node, fire } from "./dom.mjs";
import { jsPDF } from "./fakes/jspdf.mjs";

process.env.TZ = "Africa/Johannesburg";

const SHELL = (() => {
  const html = readFileSync(new URL("../../index.html", import.meta.url), "utf8");
  return html.slice(html.indexOf("<body>") + 6, html.indexOf("</body>")).replace(/<script[\s\S]*?<\/script>/g, "");
})();

class FakeStorage {
  constructor() { this.map = new Map(); }
  getItem(k) { return this.map.has(k) ? this.map.get(k) : null; }
  setItem(k, v) { this.map.set(k, String(v)); }
  removeItem(k) { this.map.delete(k); }
}

const define = (name, value) => Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });

export function installBrowser({ hash = "" } = {}) {
  const env = {
    errors: [], downloads: [], blobs: new Map(), scripts: [], confirms: [], confirmAnswers: [],
    navigations: [], replaced: [], shares: [], revoked: [], pdfPages: 2,
  };
  const doc = new Document(env);
  doc.body.innerHTML = SHELL;
  const win = new Node(doc);
  env.document = doc;
  env.window = win;
  env.localStorage = new FakeStorage();
  env.sessionStorage = new FakeStorage();
  env.location = {
    hash, pathname: "/cashup/", search: "",
    get href() { return "https://example.test/cashup/" + this.hash; },
    set href(v) { env.navigations.push(v); },
  };
  env.history = { replaceState(s, t, url) { env.replaced.push(url); env.location.hash = ""; } };
  env.navigator = { userAgent: "node-test" };
  let blobN = 0, seed = 0;

  env.download = a => env.downloads.push({ name: a.getAttribute("download"), href: a.getAttribute("href"), blob: env.blobs.get(a.getAttribute("href")) });
  env.loadScript = sc => {
    const src = sc.getAttribute("src") || "";
    env.scripts.push(src);
    if (/jspdf/.test(src)) win.jspdf = { jsPDF };
    else if (/pdf\.js/.test(src)) win.pdfjsLib = fakePdfjs(env);
    else return queueMicrotask(() => sc.onerror && sc.onerror());
    queueMicrotask(() => sc.onload && sc.onload());
  };
  // a user's click: pointer down, focus moves, then the click itself
  env.userClick = el => {
    fire(el, "pointerdown", { pointerId: 1, clientX: 0, clientY: 0 });
    if (["input", "button", "textarea", "select", "a"].includes(el.localName) && !el.disabled) doc._focus(el);
    fire(el, "mouseup");
    el.click();
  };

  define("document", doc);
  define("window", win);
  define("location", env.location);
  define("history", env.history);
  define("navigator", env.navigator);
  define("localStorage", env.localStorage);
  define("sessionStorage", env.sessionStorage);
  define("confirm", msg => { env.confirms.push(msg); return env.confirmAnswers.length ? env.confirmAnswers.shift() : true; });
  // fixed "random" bytes so new salts and PIN hashes come out the same every run, and a digest
  // that finishes on the next microtask (the real one runs on a worker thread, so timing would vary)
  const digest = async (algo, data) => { const h = createHash("sha256").update(new Uint8Array(data)).digest(); return h.buffer.slice(h.byteOffset, h.byteOffset + h.byteLength); };
  define("crypto", { subtle: { digest }, getRandomValues: a => { for (let i = 0; i < a.length; i++) a[i] = (seed++ * 37 + 11) & 255; return a; } });
  define("Image", class {
    constructor() { this.width = 0; this.height = 0; }
    get src() { return this._src; }
    set src(u) {
      this._src = u;
      // size: from the test (file.__img), else from a fake canvas's "image/…|WxH|…" contents, else 1200 x 1600
      const f = env.blobs.get(u);
      const sized = f && !f.__img && typeof f.text === "function" ? f.text() : Promise.resolve("");
      sized.then(text => {
        const m = /^image\/\w+\|(\d+)x(\d+)/.exec(text);
        const meta = (f && f.__img) || (m ? { w: +m[1], h: +m[2] } : { w: 1200, h: 1600 });
        if (meta.broken) return this.onerror && this.onerror();
        this.width = meta.w; this.height = meta.h;
        if (this.onload) this.onload();
      });
    }
  });
  URL.createObjectURL = blob => { const u = "blob:fake/" + ++blobN; env.blobs.set(u, blob); return u; };
  URL.revokeObjectURL = u => env.revoked.push(u);
  return env;
}

// pdf.js stand-in: every PDF has env.pdfPages A4 pages
function fakePdfjs(env) {
  return {
    GlobalWorkerOptions: {},
    getDocument: () => ({
      promise: Promise.resolve({
        numPages: env.pdfPages,
        getPage: async () => ({
          getViewport: ({ scale }) => ({ width: 595 * scale, height: 842 * scale }),
          render: () => ({ promise: Promise.resolve() }),
        }),
      }),
    }),
  };
}

// let promises, crypto and fake database writes finish
export async function settle(rounds = 60) { for (let i = 0; i < rounds; i++) await new Promise(r => setImmediate(r)); }
