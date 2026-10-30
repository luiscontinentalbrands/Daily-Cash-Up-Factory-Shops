// Characterization tests: leftover "cdmanager" sheets (the separate City Deep manager sign-off,
// since removed) are stored in some days but change nothing on screen, in the PDF or in History.
import { test } from "node:test";
import assert from "node:assert/strict";
import { boot } from "./harness/boot.mjs";
import { DAY, at, dayDocs, sheet } from "./harness/fixtures.mjs";

const ALL = ["wholesale", "retail", "citydeep", "manager"];
const withCm = signed => ({ ...dayDocs(DAY, { signed }), [`cashups/${DAY}_cdmanager`]: sheet(DAY, "cdmanager", { signedBy: "Old Manager", signedAt: at(DAY, "17:20") }) });

for (const [label, me, tab, signed] of [
  ["End of Day", "u-mgr", "combined", ["wholesale", "retail", "citydeep"]],
  ["City Deep sheet", "u-cd", "citydeep", ["citydeep"]],
  ["History", "u-admin", "history", ALL],
]) {
  test(`a stored cdmanager sheet is ignored: ${label}`, async t => {
    const seen = [];
    for (const docs of [dayDocs(DAY, { signed }), withCm(signed)]) {
      const app = await boot(t, { me, docs, now: `${DAY}T20:00:00+02:00` });
      await app.tab(tab);
      if (tab === "combined") await app.click("#pdf-dl");
      seen.push({ html: app.html(), pdf: app.env.downloads[0] && (await app.env.downloads[0].blob.text()), writes: app.writes() });
      t.mock.timers.reset();
    }
    assert.deepEqual(seen[1], seen[0]);
  });
}
