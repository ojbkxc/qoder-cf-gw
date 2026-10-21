import test from "node:test";
import assert from "node:assert/strict";
import { candidateAccounts } from "../src/accounts.js";

function memoryKV() {
  const map = new Map();
  return {
    async get(key, type) {
      const value = map.get(key);
      if (value === undefined) return null;
      return type === "json" ? JSON.parse(value) : value;
    },
    async put(key, value) {
      map.set(key, String(value));
    },
    async delete(key) {
      map.delete(key);
    },
  };
}

async function envWithAccounts(count) {
  const env = { KV: memoryKV() };
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const rows = Array.from({ length: count }, (_, i) => ({
    id: `acct-${i}`,
    uid: `uid-${i}`,
    label: `acct-${i}`,
    token: `dt-test-${i}`,
    refresh_token: "",
    expires_at: "",
    exp,
    refresh_dead: 0,
    failed_at: 0,
  }));
  await env.KV.put("accounts:index", JSON.stringify(rows.map((r) => r.id)));
  for (const row of rows) await env.KV.put(`account:${row.id}`, JSON.stringify(row));
  return env;
}

test("账号池：并发请求从不同账号起跑", async () => {
  const env = await envWithAccounts(3);
  const picks = await Promise.all([
    candidateAccounts(env),
    candidateAccounts(env),
    candidateAccounts(env),
  ]);
  const starts = picks.map((list) => list[0].id);
  assert.equal(new Set(starts).size, 3);
  const next = await candidateAccounts(env);
  assert.equal(next.length, 3);
  assert.ok(starts.includes(next[0].id));
});

test("账号池：失败冷却账号被排除", async () => {
  const env = await envWithAccounts(3);
  const failed = await env.KV.get("account:acct-1", "json");
  failed.failed_at = Math.floor(Date.now() / 1000);
  await env.KV.put("account:acct-1", JSON.stringify(failed));

  const list = await candidateAccounts(env);
  assert.equal(list.length, 2);
  assert.equal(list.some((a) => a.id === "acct-1"), false);
});
