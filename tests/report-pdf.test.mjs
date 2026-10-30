// Characterization tests: report-pdf.js, the End of Day PDF shared by the app and the email job.
// Uses the recording jsPDF, so each "PDF" is the list of drawing calls.
import { test } from "node:test";
import assert from "node:assert/strict";
import { snap } from "./harness/boot.mjs";
import { jsPDF } from "./harness/fakes/jspdf.mjs";
import { buildReportPdf, reportFileName } from "../report-pdf.js";
import { DAY, PRE, PHOTO, at, dayDocs } from "./harness/fixtures.mjs";

const day = (date, signed) => {
  const d = dayDocs(date, { signed });
  return { W: d[`cashups/${date}_wholesale`], Rt: d[`cashups/${date}_retail`], M: d[`cashups/${date}_manager`], C: d[`cashups/${date}_citydeep`] || null };
};
const calls = pdf => pdf.output("string");

test("all shops, signed, with handovers and photos", t => {
  const { W, Rt, M, C } = day(DAY, ["wholesale", "retail", "citydeep", "manager"]);
  Rt.notes = "Coins short R2,50 – recounted";
  const pdf = buildReportPdf(jsPDF, {
    date: DAY, niceDate: "Wednesday, 28 October 2026", W, Rt, M, C, status: "Completed on time",
    handovers: [{ amount: 300, givenBy: "Rita Retail", receivedBy: "Candido", at: at(DAY, "17:30") }, { amount: 5, givenBy: "", receivedBy: "" }],
    photos: [{ dept: "retail", data: PHOTO, by: "Rita Retail", takenAt: at(DAY, "16:00") }, { dept: "citydeep", data: "not a photo" }, { dept: "wholesale", data: PHOTO }],
  });
  snap(t, calls(pdf));
});

test("before City Deep, nothing signed, missing sheets", t => {
  const { W, Rt } = day(PRE, []);
  snap(t, calls(buildReportPdf(jsPDF, { date: PRE, W, Rt, M: null, C: null, status: "INCOMPLETE at 7 pm - missing Wholesale, Manager" })), "incomplete");
  snap(t, calls(buildReportPdf(jsPDF, { date: PRE, W: null, Rt: null, M: null })), "empty");
});

test("long notes wrap and push the signatures to a new page", t => {
  const { W, Rt, M, C } = day(DAY, ["wholesale"]);
  W.notes = Array.from({ length: 60 }, (_, i) => "word" + i).join(" ");
  Rt.notes = W.notes; C.notes = W.notes;
  W.signature = "data:image/png;base64,bad!";
  snap(t, calls(buildReportPdf(jsPDF, { date: DAY, W, Rt, M, C, status: "Due" })));
});

test("file name", () => {
  assert.equal(reportFileName(DAY), "Cash-Up-2026-10-28.pdf");
});
