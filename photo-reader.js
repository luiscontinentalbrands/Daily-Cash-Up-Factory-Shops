// The photo reader: sends the photo of a till report to Gemini (Firebase AI Logic) and turns its reply
// into an amount per payment type. app.js shows the messages and fills in the sheet.
import { AI_MODEL } from "./firebase-config.js?v=2026-11-03a";
import { DEPTS, METHODS, isRetail } from "./cashup-core.js?v=2026-11-03a";

// Model names change over time: try the configured one first, then current fallbacks, and remember what worked.
const AI_MODELS = [
  ...new Set(
    [
      AI_MODEL,
      "gemini-3.5-flash",
      "gemini-3.1-flash-lite",
      "gemini-3.5-flash-lite",
      "gemini-flash-latest",
      "gemini-2.5-flash",
      "gemini-2.0-flash",
    ].filter(Boolean),
  ),
];
// Two routes to Gemini: "Agent Platform" (Vertex AI, Blaze plan, no extra key) first, then the Gemini Developer API.
const AI_ROUTES = [
  ["vertex-global", m => new m.VertexAIBackend("global")],
  ["vertex-us", m => new m.VertexAIBackend("us-central1")],
  ["google", m => new m.GoogleAIBackend()],
];
let aiMod = null;
const aiInst = {};
export async function readWithAI(app, parts) {
  if (!aiMod) aiMod = await import("https://www.gstatic.com/firebasejs/12.17.1/firebase-ai.js");
  let good = null;
  try {
    good = JSON.parse(localStorage.getItem("cu_airoute") || "null");
  } catch (e) {}
  const combos = [];
  if (good && good.r && good.m) combos.push([good.r, good.m]);
  for (const [r] of AI_ROUTES)
    for (const m of AI_MODELS) if (!(good && good.r === r && good.m === m)) combos.push([r, m]);
  let last = null,
    lastUseful = null;
  const deadRoutes = new Set();
  for (const [route, name] of combos) {
    if (deadRoutes.has(route)) continue;
    try {
      if (!aiInst[route]) aiInst[route] = aiMod.getAI(app, { backend: AI_ROUTES.find(x => x[0] === route)[1](aiMod) });
      const model = aiMod.getGenerativeModel(aiInst[route], {
        model: name,
        generationConfig: { responseMimeType: "application/json", temperature: 0 },
      });
      const r = await model.generateContent(parts);
      try {
        localStorage.setItem("cu_airoute", JSON.stringify({ r: route, m: name }));
      } catch (e) {}
      return r;
    } catch (e) {
      last = e;
      const t = String((e && (e.message || e.code)) || "");
      if (/Failed to fetch|NetworkError|network/i.test(t)) throw e; // no connection: stop
      if (/quota|429|RESOURCE_EXHAUSTED/i.test(t)) {
        lastUseful = e;
        deadRoutes.add(route);
        continue;
      }
      if (
        /not.?found|404|not supported|is not available|unsupported model|invalid model/i.test(t) &&
        !/genai|config/i.test(t)
      )
        continue; // model unknown: try next model
      // route not set up / not allowed: try the next route
      lastUseful = lastUseful || e;
      deadRoutes.add(route);
    }
  }
  throw lastUseful || last || new Error("No AI model available");
}
// The instructions sent to the photo reader with the picture of the till report
export function readerPrompt(dept) {
  return `This is a photo of the last page of a South African retail till cash-up / Z-report (amounts in Rand) for the ${DEPTS[dept]} department of a factory shop.
Read the TOTAL amount per payment/tender type as printed on the report. Map tenders to these keys:
- cash: Cash (notes and coins tender)
- cashguard: CashGuard (cash recycler / CashGuard tender)
- card: Credit card / debit card / speedpoint / card machine totals combined${isRetail(dept) ? " (in this shop, amounts printed as EFT are card-machine payments: include them here)" : ""}
${dept === "wholesale" || dept === "retail" ? "- cardcbm: Credit card CBM (the CBM card machine; keep separate from card)\n" : ""}${dept === "wholesale" ? "- payfast: PayFast card payments (keep these separate from card)\n" : ""}- eft: EFT / bank transfer${isRetail(dept) ? " (always null for this shop: put EFT amounts under card)" : ""}
- shop2shop: Shop2Shop
- snapscan: SnapScan
Return ONLY JSON: {"cash":number|null,"cashguard":number|null,"card":number|null,${dept === "wholesale" || dept === "retail" ? '"cardcbm":number|null,' : ""}${dept === "wholesale" ? '"payfast":number|null,' : ""}"eft":number|null,"shop2shop":number|null,"snapscan":number|null,"total":number|null,"date":"YYYY-MM-DD"|null,"readable":true|false}
Use null when a tender is not on the report. Give amounts as plain JSON numbers with a dot for decimals (e.g. 1234.56), without currency symbols, spaces or thousands separators, even if the slip prints them as "R 1 234,56". Set readable false if the photo is not a cash-up report or too blurry to read.`;
}
// The reader's reply as JSON (it sometimes wraps it in ``` fences)
export function parseReaderReply(text) {
  return JSON.parse(
    text
      .trim()
      .replace(/^\`\`\`(json)?/i, "")
      .replace(/\`\`\`$/, ""),
  );
}
// Why the photo reader failed, in words for the person at the till
export function explainReaderError(raw) {
  if (/App Check/i.test(raw)) return "Google's App Check protection is not set up for this app yet.";
  if (/genai|config not found/i.test(raw))
    return "Firebase AI Logic is not fully set up for this project (Gemini Developer API link missing).";
  if (/not.?enabled|has not been used|SERVICE_DISABLED|enable the/i.test(raw))
    return "The AI reader is not switched on in Firebase yet.";
  // before the model check: quota messages often name the model ("Quota exceeded for model …")
  if (/quota|429|RESOURCE_EXHAUSTED/i.test(raw)) return "The free AI allowance for today is used up.";
  if (/not found|404|is not supported|model/i.test(raw))
    return "None of the AI models were accepted by your project. Check that AI Logic is set up with the Gemini Developer API.";
  if (/API key|referer|referrer|blocked/i.test(raw)) return "The Firebase web key is not allowed to use the AI reader.";
  if (/Failed to fetch|network|import/i.test(raw)) return "The AI reader could not be reached (connection).";
  return "The AI reader refused the request.";
}
// An amount from the reader: a number, or text like "R 1 234,56" / "1.234,56" / "1,234.56"; null when it is neither
export function readerNumber(v) {
  if (typeof v === "number") return isFinite(v) ? v : null;
  if (typeof v !== "string") return null;
  let t = v.replace(/[R\s\u00a0]/gi, "");
  if (!t) return null;
  // a comma after the last point: points are thousands separators, and the comma is the decimal mark when
  // 1 or 2 digits follow it; otherwise commas are thousands separators
  if (t.lastIndexOf(",") > t.lastIndexOf("."))
    t = t
      .replace(/\./g, "")
      .replace(/,(?=\d{1,2}$)/, ".")
      .replace(/,/g, "");
  else t = t.replace(/,/g, "");
  const n = parseFloat(t);
  return isFinite(n) ? n : null;
}
// The reader's own names for each payment type (compared in lower case, letters and digits only)
const READER_ALIASES = {
  cash: ["cash"],
  cashguard: ["cashguard"],
  card: ["card", "creditcard", "cards"],
  payfast: ["payfast", "payfastcard"],
  cardcbm: ["cardcbm", "creditcardcbm", "cbm"],
  eft: ["eft"],
  shop2shop: ["shop2shop", "shoptoshop"],
  snapscan: ["snapscan"],
};
// The reader's reply turned into an amount (or null) per payment type, and the report total
export function readerValues(out, dept) {
  const low = {};
  Object.keys(out || {}).forEach(k => (low[k.toLowerCase().replace(/[^a-z0-9]/g, "")] = out[k]));
  const total = readerNumber(low.total);
  const vals = {};
  METHODS.forEach(m => {
    let v = null;
    for (const k of READER_ALIASES[m.k] || []) {
      if (low[k] != null) {
        v = readerNumber(low[k]);
        break;
      }
    }
    vals[m.k] = v;
  });
  // Retail: slips marked EFT are credit card payments, so they are added to Credit card
  if (isRetail(dept) && vals.eft != null) {
    vals.card = (vals.card || 0) + vals.eft;
    vals.eft = null;
  }
  return { vals, total };
}
