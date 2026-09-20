// Guards every route of the deployed proxy. Run after each worker deploy:
//   BASE=https://xrf.ship2market.ai node test/worker.routes.test.js
const BASE = process.env.BASE || "https://xrf.ship2market.ai";
const checks = [
  ["GET /", "/", {}, r => r.status === 200 && r.body.includes("Reply Filter for X")],
  ["GET /privacy", "/privacy", {}, r => r.status === 200 && r.body.includes("Privacy Policy")],
  ["GET /quota", "/quota", {}, r => r.status === 200 && "limit" in JSON.parse(r.body)],
  ["GET unknown -> 404", "/nope", {}, r => r.status === 404],
  ["POST bad json -> 400", "/classify", { method: "POST", body: "{" }, r => r.status === 400],
  ["POST bad shape -> 400", "/classify", { method: "POST", body: JSON.stringify({ installId: "x" }) }, r => r.status === 400],
];
(async () => {
  let bad = 0;
  for (const [name, path, init, ok] of checks) {
    const res = await fetch(BASE + path, { headers: { "Content-Type": "application/json" }, ...init });
    const r = { status: res.status, body: await res.text() };
    const pass = ok(r);
    bad += !pass;
    console.log(`${pass ? "PASS" : "FAIL"} ${name} (${r.status})`);
  }
  process.exit(bad ? 1 : 0);
})();
