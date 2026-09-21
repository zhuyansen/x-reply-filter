import { DurableObject } from "cloudflare:workers";

// Quota counters live here instead of KV: Durable Object storage has no daily write cap, and the
// check-and-increment happens inside one object, so two concurrent requests cannot both slip past a limit.
export class Counters extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec("CREATE TABLE IF NOT EXISTS counters (k TEXT PRIMARY KEY, v REAL NOT NULL)");
  }

  #get(k) {
    const row = this.sql.exec("SELECT v FROM counters WHERE k = ?", k).toArray()[0];
    return row ? Number(row.v) : 0;
  }

  #add(k, delta) {
    const next = this.#get(k) + delta;
    this.sql.exec("INSERT INTO counters (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", k, next);
    return next;
  }

  // Atomically check both limits and reserve the replies. Returns the decision for the caller.
  reserve(day, ip, n, perIp, budgetUsd) {
    this.sql.exec("DELETE FROM counters WHERE k < ?", `d:${day}`);  // yesterday's rows sort before today's
    const spent = this.#get(`d:${day}:spend`);
    if (spent >= budgetUsd) return { ok: false, reason: "budget" };
    const used = this.#get(`d:${day}:ip:${ip}`);
    if (used + n > perIp) return { ok: false, reason: "quota", used, limit: perIp };
    if (used === 0) this.#add(`h:${day}:ips`, 1);  // first request from this IP today
    return { ok: true, used: this.#add(`d:${day}:ip:${ip}`, n), limit: perIp };
  }

  settle(day, ip, n, cost, ok) {
    if (ok) {
      this.#add(`d:${day}:spend`, cost || 0);
      this.#add(`h:${day}:spend`, cost || 0);   // h: rows are the permanent daily rollup, never pruned
      this.#add(`h:${day}:replies`, n);
    }
    else this.#add(`d:${day}:ip:${ip}`, -n);  // jev failed: give the reservation back
  }

  usage(day, ip) {
    return { used: this.#get(`d:${day}:ip:${ip}`), spend: this.#get(`d:${day}:spend`) };
  }

  // Everything the daily report needs, in one call. Reads the permanent rollup, so past days survive pruning.
  report(day) {
    const live = this.sql.exec("SELECT k, v FROM counters WHERE k LIKE ?", `d:${day}:ip:%`).toArray();
    return {
      day,
      // today's live rows are exact; the rollup is what survives for past days
      ips: Math.max(this.#get(`h:${day}:ips`), live.length),
      replies: this.#get(`h:${day}:replies`),
      spend: this.#get(`h:${day}:spend`),
      top: live.map(r => Number(r.v)).sort((a, b) => b - a).slice(0, 5),
    };
  }

  history(n) {
    const rows = this.sql.exec("SELECT k, v FROM counters WHERE k LIKE 'h:%'").toArray();
    const days = {};
    for (const r of rows) {
      const [, day, field] = r.k.split(":");
      (days[day] ||= { day, ips: 0, replies: 0, spend: 0 })[field] = Number(r.v);
    }
    return Object.values(days).sort((a, b) => b.day.localeCompare(a.day)).slice(0, n);
  }
}
