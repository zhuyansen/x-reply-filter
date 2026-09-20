const CATS = ["spam", "bait", "offtopic", "slop"];
const $ = id => document.getElementById(id);

async function load() {
  const s = await chrome.storage.sync.get({ apiKey: "", threshold: 0.75, categories: {}, customKeywords: [], blockedHandles: [] });
  $("keywords").value = s.customKeywords.join("\n"); $("handles").value = s.blockedHandles.join("\n");
  $("apiKey").value = s.apiKey; $("threshold").value = s.threshold;
  CATS.forEach(c => { $("c_" + c).checked = s.categories[c] !== false; });
  renderStats(); renderMode(); renderExamples(); renderRecent();
}

async function renderMode() {
  const { apiKey } = await chrome.storage.sync.get({ apiKey: "" });
  const { quota } = await chrome.storage.local.get({ quota: null });
  $("mode").innerHTML = apiKey ? "模式：<b>自带 key</b>，直连 OpenRouter，不限量"
    : `模式：<b>免费额度</b>${quota ? `，今日已用 <b>${quota.used}</b> / ${quota.limit} 条` : "，每天 300 条回复"}`;
}

async function renderStats() {
  const { stats } = await chrome.storage.local.get({ stats: { calls: 0, replies: 0, input_tokens: 0, output_tokens: 0, cost: 0 } });
  $("stats").innerHTML = `jev 调用 <b>${stats.calls}</b> 次 · 判定回复 <b>${stats.replies}</b> 条 · tokens <b>${stats.input_tokens + stats.output_tokens}</b> · 费用 <b>$${stats.cost.toFixed(5)}</b>`;
}

async function save() {
  const categories = Object.fromEntries(CATS.map(c => [c, $("c_" + c).checked]));
  const lines = id => $(id).value.split("\n").map(x => x.trim()).filter(Boolean);
  await chrome.storage.sync.set({ apiKey: $("apiKey").value.trim(), threshold: Number($("threshold").value), categories,
    customKeywords: lines("keywords"), blockedHandles: lines("handles").map(h => h.replace(/^@/, "")) });
  $("msg").textContent = "已保存"; setTimeout(() => ($("msg").textContent = ""), 1500);
  renderMode();
}

async function exportLog() {
  const { stats } = await chrome.storage.local.get("stats");
  const rec = { ts: new Date().toISOString(), label: "x-reply-filter", channel: "openrouter", id: null, model: "~typesafe/jev-latest",
    input_tokens: stats?.input_tokens || 0, output_tokens: stats?.output_tokens || 0, cost: stats?.cost || 0, questions: stats?.replies || 0 };
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([JSON.stringify(rec) + "\n"], { type: "application/json" }));
  a.download = "x-reply-filter.jsonl"; a.click();
}

async function clearCache() {
  const all = await chrome.storage.local.get(null);
  await chrome.storage.local.remove(Object.keys(all).filter(k => k.startsWith("v:") || k.startsWith("h:")));
  $("msg").textContent = "缓存已清空";
}

function exampleRow(kind, e) {
  const row = document.createElement("div");
  row.style.cssText = "display:flex;gap:8px;align-items:center;padding:6px 0;border-bottom:1px solid #eee;font-size:13px";
  const tag = document.createElement("span"); tag.textContent = kind === "bad" ? "不想看" : "想保留";
  tag.style.cssText = `flex:none;padding:1px 8px;border-radius:999px;color:#fff;background:${kind === "bad" ? "#b33" : "#0a7d2c"}`;
  const text = document.createElement("span"); text.textContent = `@${e.h}: ${e.t}`; text.style.flex = "1";
  const del = document.createElement("a"); del.textContent = "删除"; del.style.cssText = "cursor:pointer;color:#1d9bf0;flex:none";
  del.onclick = async () => { const { examples } = await chrome.storage.local.get({ examples: { bad: [], good: [] } });
    examples[kind] = examples[kind].filter(x => x.id !== e.id); await chrome.storage.local.set({ examples, ["v:" + e.id]: null, ["keep:" + e.id]: false }); renderExamples(); };
  row.append(tag, text, del); return row;
}

async function renderExamples() {
  const { examples } = await chrome.storage.local.get({ examples: { bad: [], good: [] } });
  const box = $("examples"); box.textContent = "";
  const all = [...examples.bad.map(e => ["bad", e]), ...examples.good.map(e => ["good", e])].sort((a, b) => (b[1].ts || 0) - (a[1].ts || 0));
  if (!all.length) { box.textContent = "还没有例子。两种添加方式：① 在推文页把鼠标悬停在一条回复上，点右上角出现的「隐藏」；② 在上面的「待确认」列表里点「对，不想看」。"; return; }
  all.forEach(([k, e]) => box.appendChild(exampleRow(k, e)));
}

async function confirmRecent(row, kind) {
  const { examples, recent } = await chrome.storage.local.get({ examples: { bad: [], good: [] }, recent: [] });
  const other = kind === "bad" ? "good" : "bad";
  examples[other] = examples[other].filter(e => e.id !== row.id);
  examples[kind] = [...examples[kind].filter(e => e.id !== row.id), { id: row.id, t: row.t, h: row.h, ts: Date.now() }].slice(-30);
  await chrome.storage.local.set({ examples, recent: recent.filter(r => r.id !== row.id),
    ["v:" + row.id]: kind === "bad" ? { cat: "user", p: 1 } : null, ["keep:" + row.id]: kind === "good" });
}

function recentRow(r) {
  const row = document.createElement("div");
  row.style.cssText = "display:flex;gap:8px;align-items:center;padding:6px 0;border-bottom:1px solid #eee;font-size:13px";
  const tag = document.createElement("span"); tag.textContent = r.reason + (r.p ? ` ${Math.round(r.p * 100)}%` : "");
  tag.style.cssText = "flex:none;padding:1px 8px;border-radius:999px;background:#e6e6e6";
  const text = document.createElement("span"); text.textContent = `@${r.h}: ${r.t}`; text.style.flex = "1";
  const mk = (label, kind, color) => { const a = document.createElement("a"); a.textContent = label; a.style.cssText = `cursor:pointer;flex:none;color:${color}`; a.onclick = () => confirmRecent(r, kind); return a; };
  row.append(tag, text, mk("对，不想看", "bad", "#b33"), mk("判错了，保留", "good", "#0a7d2c")); return row;
}

async function renderRecent() {
  const { recent } = await chrome.storage.local.get({ recent: [] });
  const box = $("recent"); box.textContent = "";
  if (!recent.length) { box.textContent = "暂无。打开一条推文的评论区，被自动折叠的回复会出现在这里。"; return; }
  [...recent].reverse().forEach(r => box.appendChild(recentRow(r)));
}

// Live update: marking a reply on x.com shows up here without reloading this page.
chrome.storage.onChanged.addListener((ch, area) => { if (area === "local" && (ch.examples || ch.recent)) { renderExamples(); renderRecent(); } if (area === "local" && ch.stats) renderStats(); });

$("clearExamples").onclick = async () => { await chrome.storage.local.set({ examples: { bad: [], good: [] } }); renderExamples(); };
$("save").onclick = save; $("export").onclick = exportLog; $("clear").onclick = clearCache;
load();
