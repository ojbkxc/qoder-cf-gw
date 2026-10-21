import test from "node:test";
import assert from "node:assert/strict";
import { createApiKey, deleteApiKey, listApiKeys, updateApiKey, verifyApiKey } from "../src/store.js";

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

test("API Key：留空自动生成 sk- 随机值", async () => {
  const env = { KV: memoryKV() };
  const created = await createApiKey(env, "auto", { key: "   " });
  assert.match(created.key, /^sk-[0-9a-f]{48}$/);
  const row = await verifyApiKey(env, created.key);
  assert.equal(row.id, created.id);
});

test("API Key：自定义密钥值原样生效", async () => {
  const env = { KV: memoryKV() };
  const custom = "my-custom-key-2026";
  const created = await createApiKey(env, "custom", { key: custom });
  assert.equal(created.key, custom);
  const row = await verifyApiKey(env, custom);
  assert.equal(row.id, created.id);
  const keys = await listApiKeys(env);
  assert.equal(keys.length, 1);
  assert.equal(keys[0].name, "custom");
});

test("API Key：非法与重复自定义值被拒绝", async () => {
  const env = { KV: memoryKV() };
  for (const bad of ["short", "has space-key", "x".repeat(201)]) {
    await assert.rejects(
      () => createApiKey(env, "bad", { key: bad }),
      (e) => e.status === 400
    );
  }
  const custom = "unique-custom-key";
  await createApiKey(env, "first", { key: custom });
  await assert.rejects(
    () => createApiKey(env, "second", { key: custom }),
    (e) => e.status === 409
  );
});

test("API Key：删除后自定义密钥立即失效", async () => {
  const env = { KV: memoryKV() };
  const custom = "deletable-custom-key";
  const created = await createApiKey(env, "delete-me", { key: custom });
  assert.ok(await verifyApiKey(env, custom));
  await deleteApiKey(env, created.id);
  assert.equal(await verifyApiKey(env, custom), null);
});

test("API Key：列表回显明文与脱敏预览", async () => {
  const env = { KV: memoryKV() };
  const created = await createApiKey(env, "show", { key: "plaintext-visible-key" });
  const [row] = await listApiKeys(env);
  assert.equal(row.key_value, "plaintext-visible-key");
  assert.equal(row.key, "plaintext-visible-key");
  assert.equal(row.key_preview, "plain...y");
  assert.equal(created.key_value, "plaintext-visible-key");
});

test("API Key：剩余次数口径换算总量，0 表示不限", async () => {
  const env = { KV: memoryKV() };
  const created = await createApiKey(env, "quota", { max_calls: 10 });
  const updated = await updateApiKey(env, created.id, { remaining_calls: 7 });
  assert.equal(updated.max_calls, 7);
  assert.equal(updated.used_calls, 0);
  assert.equal(updated.remaining_calls, 7);
  const unlimited = await updateApiKey(env, created.id, { remaining_calls: 0 });
  assert.equal(unlimited.max_calls, 0);
  assert.equal(unlimited.remaining_calls, null);
});

test("API Key：编辑可轮换热密钥，旧值立即失效且可与他人冲突时拒绝", async () => {
  const env = { KV: memoryKV() };
  const created = await createApiKey(env, "rotate", { key: "first-secret-key-value" });
  const rotated = await updateApiKey(env, created.id, { key_value: "second-secret-key-value" });
  assert.equal(rotated.key_value, "second-secret-key-value");
  assert.equal(await verifyApiKey(env, "first-secret-key-value"), null);
  assert.ok(await verifyApiKey(env, "second-secret-key-value"));
  const back = await updateApiKey(env, created.id, { key_value: "first-secret-key-value" });
  assert.equal(back.key_value, "first-secret-key-value");
  assert.ok(await verifyApiKey(env, "first-secret-key-value"));
  assert.equal(await verifyApiKey(env, "second-secret-key-value"), null);
  await createApiKey(env, "other", { key: "brand-new-key-value" });
  await assert.rejects(
    () => updateApiKey(env, created.id, { key_value: "brand-new-key-value" }),
    (e) => e.status === 409
  );
});

test("API Key：有效期未传则保持不变，显式传 0 转永久", async () => {
  const env = { KV: memoryKV() };
  const future = Math.floor(Date.now() / 1000) + 5 * 86400;
  const created = await createApiKey(env, "exp", { expires_at: future });
  const kept = await updateApiKey(env, created.id, { name: "renamed" });
  assert.equal(kept.expires_at, future);
  assert.equal(kept.name, "renamed");
  assert.equal(kept.remaining_days, 5);
  const forever = await updateApiKey(env, created.id, { expires_at: 0 });
  assert.equal(forever.expires_at, 0);
  assert.equal(forever.remaining_days, null);
});
