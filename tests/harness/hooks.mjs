// Points the app's and the email job's outside dependencies at the fakes in ./fakes.
// Used in-process by the app tests, and with `node --import` for the email job.
import { registerHooks } from "node:module";

const FAKE = name => new URL(`./fakes/${name}.mjs`, import.meta.url).href;
const PACKAGES = { "firebase-admin": FAKE("firebase-admin"), nodemailer: FAKE("nodemailer"), jspdf: FAKE("jspdf") };

registerHooks({
  resolve(specifier, context, next) {
    const m = /^https:\/\/www\.gstatic\.com\/firebasejs\/[\d.]+\/(firebase-[a-z-]+)\.js$/.exec(specifier);
    if (m) return { url: FAKE(m[1]), shortCircuit: true };
    if (PACKAGES[specifier]) return { url: PACKAGES[specifier], shortCircuit: true };
    return next(specifier, context);
  },
});

// Email job only: a fixed clock, so "today" and the log timestamps are the same every run.
if (process.env.FAKE_NOW) {
  const fixed = Date.parse(process.env.FAKE_NOW), Real = Date;
  globalThis.Date = class extends Real {
    constructor(...a) { super(...(a.length ? a : [fixed])); }
    static now() { return fixed; }
  };
}
