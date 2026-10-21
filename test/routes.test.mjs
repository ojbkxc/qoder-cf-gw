import test from "node:test";
import assert from "node:assert/strict";
import { getModelRoutes, routeOf, saveModelRoutes } from "../src/model-routes.js";
import { publicModelList, resolveModel, setCache } from "../src/models.js";

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

const UPSTREAM = [
  { key: "qmodel", name: "Q Model", source: "system", reasoning: true, vision: false, default: true, enabled: true, ctx: 200000, max_output_tokens: 32000, format: "openai" },
  { key: "dfmodel", name: "Deep Filter", source: "system", reasoning: false, vision: true, default: false, enabled: true, ctx: 1000000, max_output_tokens: 32000, format: "openai" },
];

function freshEnv() {
  setCache(UPSTREAM);
  return { KV: memoryKV() };
}

test("模型映射：保存后按请求名命中上游模型", async () => {
  const env = freshEnv();
  await saveModelRoutes(env, { mappings: { "gpt-4o": "qmodel" } });
  const routes = await getModelRoutes(env);
  assert.equal(routes.mappings["gpt-4o"], "qmodel");
  assert.equal(routeOf(routes, "gpt-4o").kind, "mapping");
  assert.equal(resolveModel(routeOf(routes, "gpt-4o").target).key, "qmodel");
});

test("模型映射：大小写不敏感命中源名", async () => {
  const env = freshEnv();
  await saveModelRoutes(env, { mappings: { "GPT-4O-Mini": "dfmodel" } });
  const routes = await getModelRoutes(env);
  assert.equal(routeOf(routes, "gpt-4o-mini").target, "dfmodel");
});

test("假名：可解析且出现在公开清单中", async () => {
  const env = freshEnv();
  await saveModelRoutes(env, { aliases: { "fast-one": "dfmodel" } });
  const routes = await getModelRoutes(env);
  assert.equal(routeOf(routes, "fast-one").kind, "alias");
  const ids = publicModelList(routes).map((m) => m.id);
  assert.ok(ids.includes("fast-one"));
  const entry = publicModelList(routes).find((m) => m.id === "fast-one");
  assert.equal(entry.target, "dfmodel");
});

test("映射优先于假名与上游原名", async () => {
  const env = freshEnv();
  await saveModelRoutes(env, { mappings: { "qmodel-clone": "dfmodel" }, aliases: { "my-fast": "qmodel" } });
  const routes = await getModelRoutes(env);
  assert.equal(routeOf(routes, "qmodel-clone").kind, "mapping");
  assert.equal(routeOf(routes, "my-fast").kind, "alias");
  assert.equal(routeOf(routes, "qmodel"), null);
});

test("模型映射校验：目标不存在、同名、重名假名均拒绝", async () => {
  const env = freshEnv();
  await assert.rejects(() => saveModelRoutes(env, { mappings: { "a": "nope" } }), (e) => e.status === 400);
  await assert.rejects(() => saveModelRoutes(env, { mappings: { "qmodel": "Q Model" } }), (e) => e.status === 400);
  await assert.rejects(() => saveModelRoutes(env, { mappings: { "x": "qmodel" }, aliases: { "x": "dfmodel" } }), (e) => e.status === 400);
  await assert.rejects(() => saveModelRoutes(env, { aliases: { "dfmodel": "qmodel" } }), (e) => e.status === 400);
  await assert.rejects(() => saveModelRoutes(env, { mappings: { "with space": "qmodel" } }), (e) => e.status === 400);
  await assert.rejects(() => saveModelRoutes(env, { mappings: "not-an-object" }), (e) => e.status === 400);
  await assert.rejects(() => saveModelRoutes(env, { mappings: { "ok": "" } }), (e) => e.status === 400);
});

test("模型映射：目标写显示名可归一化为 key，未传字段保持原值", async () => {
  const env = freshEnv();
  await saveModelRoutes(env, { mappings: { "one": "Deep Filter" } });
  let routes = await getModelRoutes(env);
  assert.equal(routes.mappings.one, "dfmodel");
  await saveModelRoutes(env, { aliases: { "two": "qmodel" } });
  routes = await getModelRoutes(env);
  assert.equal(routes.mappings.one, "dfmodel");
  assert.equal(routes.aliases.two, "qmodel");
});
