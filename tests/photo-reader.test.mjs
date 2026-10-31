// Unit tests for photo-reader.js: reading amounts and payment types from the reader's reply.
import { test } from "node:test";
import "./harness/hooks.mjs";
import { snap } from "./harness/boot.mjs";

const { readerNumber, readerValues, explainReaderError } = await import("../photo-reader.js?v=2026-10-31b");

test("readerNumber: the ways a slip prints an amount", t => {
  const cases = [1234.56, NaN, null, true, "", "R", "1234.56", "1234,56", "R 1 234,56", "1 234,56", "1.234,56", "1.234.567,8", "1,234.56", "1,234", "1.234", "99,9", "R1 234,5", "abc"];
  snap(t, cases.map(v => [String(v), readerNumber(v)]));
});

test("readerValues: keys in any spelling, retail EFT counted as card", t => {
  const out = { Cash: "R 10,00", "Credit Card": 100, CBM: 5, "Shop To Shop": 2, eft: "50,5", total: "1.234,56" };
  snap(t, { wholesale: readerValues(out, "wholesale"), retail: readerValues(out, "retail") });
});

test("explainReaderError: which message for which error", t => {
  const errors = ["AppCheck token invalid", "genai config not found", "SERVICE_DISABLED", "404 model not found", "429 Quota exceeded for model x", "API key blocked", "Failed to fetch", "odd"];
  snap(t, errors.map(e => [e, explainReaderError(e)]));
});
