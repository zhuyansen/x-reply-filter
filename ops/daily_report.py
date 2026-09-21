#!/usr/bin/env python3
"""Daily usage report for Reply Filter for X.

Sources: the proxy's own /report endpoint (Durable Object counters), Cloudflare analytics
(Worker invocations + KV ops), and the public Chrome Web Store page.

    python3 ops/daily_report.py            # human-readable report
    python3 ops/daily_report.py --json     # machine-readable
"""
import json, re, subprocess, sys, datetime as dt, pathlib

PROXY = "https://xrf.ship2market.ai"
TOKEN_FILE = pathlib.Path.home() / ".config/xrf/report_token"
WRANGLER_CFG = pathlib.Path.home() / "Library/Preferences/.wrangler/config/default.toml"
ACCOUNT = "111392dcb718001bfa28a9ef3b17f804"
STORE_ID = "ncffadgnbgcfadoaiaglgkbacjepccff"
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/153.0 Safari/537.36"
KV_WRITE_LIMIT = 1000


def fetch(url, headers=None, data=None, timeout=40):
    """curl, not urllib: Cloudflare blocks python-urllib's signature (error 1010) and curl already
    honours the local proxy settings this machine needs."""
    cmd = ["curl", "-sS", "-m", str(timeout), "-A", UA]
    for k, v in (headers or {}).items():
        cmd += ["-H", f"{k}: {v}"]
    if data is not None:
        cmd += ["--data-binary", data.decode() if isinstance(data, bytes) else data]
    out = subprocess.run(cmd + [url], capture_output=True, text=True)
    if out.returncode:
        raise RuntimeError(f"curl failed: {out.stderr.strip()[:120]}")
    return out.stdout


def proxy_report():
    token = TOKEN_FILE.read_text().strip()
    return json.loads(fetch(f"{PROXY}/report?token={token}"))


def cf_token():
    m = re.search(r'^oauth_token\s*=\s*"(.*)"', WRANGLER_CFG.read_text(), re.M)
    return m.group(1) if m else None


def cf_analytics(days=3):
    token = cf_token()
    if not token:
        return {}
    since = (dt.date.today() - dt.timedelta(days=days)).isoformat()
    query = """query($a:String!,$since:Date!){viewer{accounts(filter:{accountTag:$a}){
      kv:kvOperationsAdaptiveGroups(limit:100,filter:{date_geq:$since},orderBy:[date_DESC]){sum{requests}dimensions{date actionType}}
      wk:workersInvocationsAdaptive(limit:100,filter:{date_geq:$since},orderBy:[date_DESC]){sum{requests}dimensions{date scriptName}}}}}"""
    body = json.dumps({"query": query, "variables": {"a": ACCOUNT, "since": since}}).encode()
    out = json.loads(fetch("https://api.cloudflare.com/client/v4/graphql", {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}, body))
    if out.get("errors"):
        return {}
    acc = out["data"]["viewer"]["accounts"][0]
    kv, wk = {}, {}
    for g in acc["kv"]:
        kv.setdefault(g["dimensions"]["date"], {})[g["dimensions"]["actionType"]] = g["sum"]["requests"]
    for g in acc["wk"]:
        if g["dimensions"]["scriptName"] == "x-reply-filter-proxy":
            wk[g["dimensions"]["date"]] = g["sum"]["requests"]
    return {"kv": kv, "worker": wk}


def store_users():
    try:
        html = fetch(f"https://chromewebstore.google.com/detail/{STORE_ID}", {"User-Agent": UA})
    except Exception:
        return None
    for pat in [r"([\d,]+)\s*(?:位)?用户", r"([\d,]+)\s*users"]:
        m = re.search(pat, html)
        if m:
            return m.group(1)
    return None


def build():
    rep = proxy_report()
    cf = cf_analytics()
    today = rep["today"]
    hist = rep["history"]
    wk = cf.get("worker", {})
    # Only meaningful when both numbers cover the same period; on the day counters moved to Durable
    # Objects the Worker count includes pre-migration requests, so a ratio below 1 is discarded.
    per_req = round(today["replies"] / wk[today["day"]], 1) if wk.get(today["day"]) else None
    if per_req is not None and per_req < 1:
        per_req = None
    return {"today": today, "history": hist, "cf": cf, "store_users": store_users(), "replies_per_request": per_req}


def render(d):
    t, cf = d["today"], d["cf"]
    lines = [f"Reply Filter for X · {t['day']}", ""]
    lines.append(f"今日 {t['ips']} 个独立 IP · 判定 {t['replies']} 条回复 · 花费 ${t['spend']:.4f}")
    if d["store_users"]:
        lines.append(f"商店显示用户数: {d['store_users']}")
    if d["replies_per_request"]:
        lines.append(f"平均每次请求 {d['replies_per_request']} 条回复（越高越省，0.5.3 起目标 8 以上）")
    if cf.get("worker", {}).get(t["day"]):
        lines.append(f"Worker 请求 {cf['worker'][t['day']]} 次")
    lines.append("")
    lines.append(f"{'日期':<12}{'IP':>5}{'回复':>7}{'花费':>10}")
    rows = [t if h["day"] == t["day"] else h for h in d["history"][:7]]  # today's live IP count is the exact one
    for h in rows:
        lines.append(f"{h['day']:<12}{h['ips']:>5}{h['replies']:>7}{'$%.4f' % h['spend']:>10}")
    kv = cf.get("kv", {})
    if kv:
        lines.append("")
        for day in sorted(kv, reverse=True)[:3]:
            w = kv[day].get("write", 0)
            flag = "  ⚠️ 接近每日 1000 上限" if w > KV_WRITE_LIMIT * 0.5 else ""
            lines.append(f"KV {day}: 写 {w} · 读 {kv[day].get('read', 0)}{flag}")
        lines.append("（计数已迁到 Durable Objects，KV 写入应该趋近 0）")
    return "\n".join(lines)


if __name__ == "__main__":
    data = build()
    print(json.dumps(data, ensure_ascii=False, indent=1) if "--json" in sys.argv else render(data))
