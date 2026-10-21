// 模型映射与假名：请求模型名 → Qoder 上游模型。映射优先于假名。
import { getModels, resolveModel } from "./models.js";

const K_MAPPINGS = "model_routes:mappings";
const K_ALIASES = "model_routes:aliases";
const TTL_MS = 30 * 1000;
const MAX_ENTRIES = 200;

let cache = { at: 0, mappings: {}, aliases: {} };

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

export async function getModelRoutes(env) {
  if (cache.at && Date.now() - cache.at < TTL_MS) return cache;
  const [mappings, aliases] = await Promise.all([
    env.KV.get(K_MAPPINGS, "json"),
    env.KV.get(K_ALIASES, "json"),
  ]);
  cache = {
    at: Date.now(),
    mappings: plainObject(mappings),
    aliases: plainObject(aliases),
  };
  return cache;
}

export function invalidateModelRoutes() {
  cache = { at: 0, mappings: {}, aliases: {} };
}

function targetIn(map, name) {
  if (!map) return null;
  if (Object.prototype.hasOwnProperty.call(map, name)) return map[name];
  const low = name.toLowerCase();
  for (const [source, target] of Object.entries(map)) {
    if (source.toLowerCase() === low) return target;
  }
  return null;
}

export function routeOf(routes, name) {
  const source = String(name || "").trim();
  if (!source || !routes) return null;
  const mapped = targetIn(routes.mappings, source);
  if (mapped) return { kind: "mapping", source, target: mapped };
  const aliased = targetIn(routes.aliases, source);
  if (aliased) return { kind: "alias", source, target: aliased };
  return null;
}

function fail(message) {
  throw Object.assign(new Error(message), { status: 400 });
}

// 允许字母数字、- _ . / : @ 等非空白可见字符；不含空格与控制字符
const SOURCE_RE = /^[^\s\x00-\x1f]{1,100}$/;

function normalizeSource(value) {
  const source = String(value ?? "").trim();
  if (!SOURCE_RE.test(source)) fail("请求模型名需为 1-100 个非空白字符");
  return source;
}

function normalizeMap(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} 必须是对象`);
  }
  const entries = Object.entries(value);
  if (entries.length > MAX_ENTRIES) fail(`${label} 最多 ${MAX_ENTRIES} 条`);
  const out = {};
  const seen = new Set();
  for (const [rawSource, rawTarget] of entries) {
    const source = normalizeSource(rawSource);
    const low = source.toLowerCase();
    if (seen.has(low)) fail(`请求模型名 "${source}" 重复`);
    seen.add(low);
    const target = String(rawTarget ?? "").trim();
    if (!target) fail(`"${source}" 的目标模型不能为空`);
    out[source] = target;
  }
  return out;
}

export async function saveModelRoutes(env, input = {}) {
  const current = await getModelRoutes(env);
  const mappings =
    input.mappings === undefined ? { ...current.mappings } : normalizeMap(input.mappings, "模型映射");
  const aliases =
    input.aliases === undefined ? { ...current.aliases } : normalizeMap(input.aliases, "假名");
  try {
    await getModels(env);
  } catch {
    // 目标校验依赖模型缓存，缓存为空时下方会提示先刷新清单
  }

  const mappingSources = new Set(Object.keys(mappings).map((s) => s.toLowerCase()));
  const aliasSources = new Set(Object.keys(aliases).map((s) => s.toLowerCase()));
  for (const source of mappingSources) {
    if (aliasSources.has(source)) fail(`请求模型名 "${source}" 同时出现在模型映射和假名中`);
  }

  const normalizedMappings = {};
  for (const [source, target] of Object.entries(mappings)) {
    const resolved = resolveModel(target);
    if (!resolved) fail(`目标模型 "${target}" 不存在，请先刷新模型清单`);
    if (resolved.key.toLowerCase() === source.toLowerCase()) {
      fail(`"${source}" 的源和目标不能相同`);
    }
    normalizedMappings[source] = resolved.key;
  }

  const normalizedAliases = {};
  for (const [source, target] of Object.entries(aliases)) {
    if (resolveModel(source)) fail(`假名 "${source}" 与上游模型重名，请改用模型映射`);
    const resolved = resolveModel(target);
    if (!resolved) fail(`目标模型 "${target}" 不存在，请先刷新模型清单`);
    if (resolved.key.toLowerCase() === source.toLowerCase()) {
      fail(`"${source}" 的假名和目标不能相同`);
    }
    normalizedAliases[source] = resolved.key;
  }

  await Promise.all([
    env.KV.put(K_MAPPINGS, JSON.stringify(normalizedMappings)),
    env.KV.put(K_ALIASES, JSON.stringify(normalizedAliases)),
  ]);
  cache = { at: Date.now(), mappings: normalizedMappings, aliases: normalizedAliases };
  return cache;
}
