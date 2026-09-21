// Free-tier proxy: holds the OpenRouter key, enforces per-install and global daily quotas, forwards to jev.
import shared from "../../shared.js";
export { Counters } from "./counters.js";

const { MAX_REPLIES, callJev } = shared;
const ID_RE = /^[a-f0-9]{32}$/;

const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } });
const today = () => new Date().toISOString().slice(0, 10);

function validate(body) {
  if (!body || !ID_RE.test(body.installId || "")) return "bad_install_id";
  if (!body.original || typeof body.original.text !== "string") return "bad_original";
  if (!Array.isArray(body.replies) || !body.replies.length || body.replies.length > MAX_REPLIES) return "bad_replies";
  if (body.replies.some(r => typeof r.text !== "string" || typeof r.handle !== "string")) return "bad_replies";
  if (body.examples !== undefined && (typeof body.examples !== "object" || body.examples === null)) return "bad_examples";
  return null;
}

// The IP is hashed so raw addresses are never stored; installId is client-generated and unenforceable,
// so the per-IP cap is the real limit.
async function ipKey(req) {
  const ip = req.headers.get("CF-Connecting-IP") || "unknown";
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`xrf:${today()}:${ip}`));
  return Array.from(new Uint8Array(digest).slice(0, 12), b => b.toString(16).padStart(2, "0")).join("");
}

const counters = env => env.COUNTERS.get(env.COUNTERS.idFromName("global"));

async function classify(body, env, req, ctx) {
  const perIp = Number(env.DAILY_PER_IP), budget = Number(env.DAILY_BUDGET_USD);
  const day = today(), ip = await ipKey(req), stub = counters(env);

  const slot = await stub.reserve(day, ip, body.replies.length, perIp, budget);
  if (!slot.ok) return json({ error: slot.reason, used: slot.used, limit: slot.limit }, 429);

  let resp;
  try {
    resp = await callJev(env.OPENROUTER_API_KEY, body.original, body.replies, body.categories, body.examples);
  } catch (e) {
    ctx.waitUntil(stub.settle(day, ip, body.replies.length, 0, false));
    throw e;
  }
  ctx.waitUntil(stub.settle(day, ip, body.replies.length, resp.usage?.cost || 0, true));
  return json({ answers: resp.answers, usage: resp.usage, model: resp.model, quota: { used: slot.used, limit: perIp } });
}

const PAGE_CSS = "body{font:16px/1.65 -apple-system,system-ui,sans-serif;max-width:720px;margin:48px auto;padding:0 20px;color:#0f1419}h1{font-size:28px}h2{font-size:19px;margin-top:32px}code{background:#f2f4f5;padding:1px 5px;border-radius:4px}a{color:#1d9bf0}li{margin:6px 0}.muted{color:#536471;font-size:14px}";
const html = body => new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Reply Filter for X</title><style>${PAGE_CSS}</style></head><body>${body}</body></html>`, { headers: { "Content-Type": "text/html; charset=utf-8" } });

const PRIVACY = `<h1>Privacy Policy — Reply Filter for X</h1><p class="muted">Last updated: 2026-09-19</p>
<p>Reply Filter for X is a browser extension that collapses low-value replies on x.com post pages. This page explains exactly what data it handles.</p>
<h2>What the extension sends</h2><ul>
<li>The text and author handle of the post you are viewing, and the text and author handles of the replies being evaluated.</li>
<li>Up to 10 "don't want to see" and 10 "keep" example replies that you explicitly marked.</li>
<li>A random anonymous install ID generated on your device, used only for rate limiting.</li></ul>
<p>It never reads or sends your X account, cookies, passwords, direct messages, browsing history, or any page other than x.com / twitter.com post pages.</p>
<h2>Where it goes</h2><ul>
<li><b>Free mode (default):</b> to this service (<code>xrf.ship2market.ai</code>, a Cloudflare Worker), which forwards it to OpenRouter's TypeSafe Jev decision model and returns the scores.</li>
<li><b>Your own key mode:</b> directly from your browser to OpenRouter. This service is not involved.</li></ul>
<h2>What this service stores</h2><ul>
<li>Only counters: replies evaluated today per install ID, per hashed IP address, and total daily spend. They expire after 26 hours.</li>
<li>It does <b>not</b> store post text, reply text, examples, or raw IP addresses.</li></ul>
<h2>What stays on your device</h2><p>Your examples, cached verdicts, review queue, custom keywords, blocked handles and optional API key are stored in Chrome extension storage. You can delete them from the options page or by removing the extension.</p>
<h2>Sharing and selling</h2><p>Data is not sold, not used for advertising, and not used for any purpose other than deciding which replies to collapse. Third-party processors: Cloudflare (hosting) and OpenRouter / TypeSafe (model inference).</p>
<h2>Contact</h2><p>Open an issue at <a href="https://github.com/zhuyansen/x-reply-filter/issues">github.com/zhuyansen/x-reply-filter</a> or email <a href="mailto:m17551076169@gmail.com">m17551076169@gmail.com</a>.</p>`;

const HOME = `<h1>Reply Filter for X</h1><p>Collapses spam, engagement bait, off-topic and AI-filler replies on x.com. Nothing is deleted: every hidden reply becomes a one-line bar you can expand. Mark replies yourself and the AI learns your taste.</p>
<p><a href="/privacy">Privacy Policy</a> · <a href="https://github.com/zhuyansen/x-reply-filter">Source code (MIT)</a></p><p class="muted">This domain also hosts the free-tier API used by the extension.</p>`;

export default {
  async fetch(req, env, ctx) {
    if (req.method === "OPTIONS") return new Response(null, { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Allow-Methods": "POST" } });
    const url = new URL(req.url);
    if (req.method === "GET" && url.pathname === "/privacy") return html(PRIVACY);
    if (req.method === "GET" && url.pathname === "/") return html(HOME);
    if (req.method === "GET" && url.pathname === "/quota") {
      const { used } = await counters(env).usage(today(), await ipKey(req));  // per IP; the id param is kept for older clients
      return json({ used, limit: Number(env.DAILY_PER_IP) });
    }
    if (req.method === "GET" && url.pathname === "/report") {
      if (url.searchParams.get("token") !== env.REPORT_TOKEN) return json({ error: "forbidden" }, 403);
      const stub = counters(env);
      return json({ today: await stub.report(today()), history: await stub.history(14) });
    }
    if (req.method !== "POST" || url.pathname !== "/classify") return json({ error: "not_found" }, 404);
    let body; try { body = await req.json(); } catch { return json({ error: "bad_json" }, 400); }
    const err = validate(body);
    if (err) return json({ error: err }, 400);
    try { return await classify(body, env, req, ctx); }
    catch (e) { return json({ error: "upstream", detail: String(e.message || e).slice(0, 200) }, 502); }
  },
};
