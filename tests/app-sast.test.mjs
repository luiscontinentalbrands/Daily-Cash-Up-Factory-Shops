// The app on a phone or computer set to another time zone still works in South African time.
import { test } from "node:test";
import assert from "node:assert/strict";
import { boot, snap } from "./harness/boot.mjs";
import { DAY, dayDocs } from "./harness/fixtures.mjs";

test("device in New York, just after midnight in South Africa", async t => {
  process.env.TZ = "America/New_York";
  t.after(() => { process.env.TZ = "Africa/Johannesburg"; });
  const app = await boot(t, { me: "u-whole", docs: dayDocs(DAY, { signed: ["wholesale"] }), now: "2026-10-29T00:30:00+02:00" });
  assert.equal(app.$("#date").value, "2026-10-29", "today is the South African date");
  await app.date(DAY);
  snap(t, { banner: app.text(".banner"), date: app.text(".deptband .small"), signedAt: app.text(".sign .msg") });
});
