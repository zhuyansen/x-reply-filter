// Shared between the extension service worker (importScripts) and the Cloudflare Worker (import).
// Wrapped in an IIFE: importScripts() shares one global scope, so nothing here may leak as a global name.
(() => {
const JEV_MODEL = "~typesafe/jev-latest";
const JEV_ENDPOINT = "https://openrouter.ai/api/alpha/decisions";
const QUESTION_DEFS = {
  spam: ["Is this reply promotional spam, a scam, or shilling a product/crypto/AI tool?", "Promo, scam, shill or link-farming", "Genuine comment"],
  bait: ["Is this reply low-effort engagement bait (generic agreement, emoji-only, 'first', copy-paste reaction)?", "Low-effort bait", "Substantive reply"],
  offtopic: ["Is this reply unrelated to the original tweet's topic?", "Clearly off-topic", "On topic"],
  slop: ["Does this reply read like generic AI-generated filler with no specific point?", "Generic AI filler", "Specific, human-sounding"],
};
const USER_QUESTION = ["Is this reply the same KIND of low-value reply as the examples the user marked LOW-VALUE (and unlike the ones marked KEEP)?", "Same kind as the user's low-value examples", "Not like them, or like the KEEP examples"];
const MAX_REPLIES = 20;  // server accepts bigger batches; fewer requests means fewer KV writes
const MAX_TEXT = 600;
const MAX_EXAMPLES = 10;
const MAX_EXAMPLE_TEXT = 200;

function sanitizeExamples(examples) {
  const clean = list => (Array.isArray(list) ? list : []).filter(e => e && typeof e.t === "string" && e.t.trim())
    .slice(-MAX_EXAMPLES).map(e => ({ t: e.t.slice(0, MAX_EXAMPLE_TEXT), h: String(e.h || "").slice(0, 40) }));
  return { bad: clean(examples?.bad), good: clean(examples?.good) };
}

function buildState(original, replies, examples) {
  const ex = sanitizeExamples(examples);
  const lines = [`ORIGINAL TWEET by @${original.handle}: ${String(original.text).slice(0, MAX_TEXT)}`, ""];
  if (ex.bad.length) { lines.push("USER-LABELED EXAMPLES (from other threads) the user marked LOW-VALUE:"); ex.bad.forEach(e => lines.push(`- ${e.t}`)); lines.push(""); }
  if (ex.good.length) { lines.push("USER-LABELED EXAMPLES the user marked KEEP (do not hide replies like these):"); ex.good.forEach(e => lines.push(`- ${e.t}`)); lines.push(""); }
  lines.push("REPLIES:");
  replies.forEach((r, i) => lines.push(`[${i}] @${r.handle}${r.verified ? " (verified)" : ""}: ${String(r.text).slice(0, MAX_TEXT)}`));
  return lines.join("\n");
}

function buildQuestions(replies, categories, examples) {
  const qs = {};
  const hasBad = sanitizeExamples(examples).bad.length > 0;
  replies.forEach((_, i) => {
    if (hasBad && !(categories && categories.user === false)) {
      const [instr, yes, no] = USER_QUESTION;
      qs[`r${i}_user`] = { type: "noul", instructions: `Reply [${i}]: ${instr}`, criteria: { true: yes, false: no } };
    }
    for (const [cat, [instr, yes, no]] of Object.entries(QUESTION_DEFS)) {
      if (categories && categories[cat] === false) continue;
      qs[`r${i}_${cat}`] = { type: "noul", instructions: `Reply [${i}]: ${instr}`, criteria: { true: yes, false: no } };
    }
  });
  return qs;
}

function verdicts(answers, n, threshold) {
  return Array.from({ length: n }, (_, i) => {
    let worst = null;
    for (const cat of [...Object.keys(QUESTION_DEFS), "user"]) {
      const a = answers[`r${i}_${cat}`];
      if (a && a.noul >= threshold && (!worst || a.noul > worst.p)) worst = { cat, p: a.noul };
    }
    return worst;
  });
}

async function callJev(apiKey, original, replies, categories, examples, fetchImpl = fetch) {
  const body = { model: JEV_MODEL, state: buildState(original, replies, examples), questions: buildQuestions(replies, categories, examples) };
  const res = await fetchImpl(JEV_ENDPOINT, { method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", "X-OpenRouter-Title": "x-reply-filter" },
    body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`jev ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

const JEV_SHARED = { QUESTION_DEFS, MAX_REPLIES, MAX_EXAMPLES, sanitizeExamples, buildState, buildQuestions, verdicts, callJev };
if (typeof module !== "undefined") module.exports = JEV_SHARED;
globalThis.JEV_SHARED = JEV_SHARED;
})();
