// 模型清单：签名拉取 + KV 持久化 + isolate 短缓存 + 名称/别名解析。
import { candidateAccounts, ensureFresh, markFailed } from "./accounts.js";
import { normalizeModels, signedFetchModels } from "./qoder/client.js";

const TTL_MS = 60 * 1000;
const KV_TTL_MS = 6 * 3600 * 1000;
const MAX_ACCOUNTS = 6;
const K_MODELS = "models:cache";

let cache = { at: 0, updatedAt: 0, models: [], byKey: new Map(), alias: new Map() };

function slug(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function setCache(models, updatedAt = Date.now()) {
  const byKey = new Map();
  const alias = new Map();
  for (const m of models) {
    byKey.set(m.key, m);
    alias.set(m.key.toLowerCase(), m);
    alias.set(slug(m.name), m);
  }
  cache = { at: Date.now(), updatedAt, models, byKey, alias };
  return cache;
}

async function readStored(env) {
  if (!env?.KV) return null;
  try {
    const stored = await env.KV.get(K_MODELS, "json");
    if (!stored || !Array.isArray(stored.models) || !stored.models.length) return null;
    return { at: Number(stored.at) || 0, models: stored.models };
  } catch {
    return null;
  }
}

async function storeModels(env, models) {
  const updatedAt = Date.now();
  setCache(models, updatedAt);
  if (env?.KV) {
    try {
      await env.KV.put(K_MODELS, JSON.stringify({ at: updatedAt, models }));
    } catch {
      // 持久化失败仍可使用本次内存结果
    }
  }
  return cache;
}

function mergeModels(...lists) {
  const merged = new Map();
  for (const list of lists) {
    for (const m of list || []) {
      if (!m || !m.key) continue;
      const prev = merged.get(m.key);
      if (!prev) {
        merged.set(m.key, { ...m });
        continue;
      }
      const next = { ...prev };
      if ((m.ctx || 0) > (next.ctx || 0)) next.ctx = m.ctx;
      if ((m.max_output_tokens || 0) > (next.max_output_tokens || 0)) {
        next.max_output_tokens = m.max_output_tokens;
      }
      next.reasoning = Boolean(prev.reasoning || m.reasoning);
      next.vision = Boolean(prev.vision || m.vision);
      next.enabled = Boolean(prev.enabled || m.enabled);
      next.default = Boolean(prev.default || m.default);
      if ((!next.name || next.name === next.key) && m.name) next.name = m.name;
      if (!next.thinking_config && m.thinking_config) next.thinking_config = m.thinking_config;
      if (!next.format) next.format = m.format;
      if (!next.source) next.source = m.source;
      merged.set(m.key, next);
    }
  }
  return [...merged.values()];
}

async function fetchOne(env, account) {
  try {
    const fresh = await ensureFresh(env, account);
    if (fresh.refresh_dead && (!fresh.exp || fresh.exp <= Date.now() / 1000)) {
      return { error: new Error(`账号 ${fresh.label} 续期链已失效`) };
    }
    const resp = await signedFetchModels(fresh, env.QODER_GATEWAY);
    if ([401, 403].includes(resp.status)) {
      console.warn(`清单 uid=${String(fresh.uid || "").slice(0, 8)} 传输层 HTTP ${resp.status}`);
      await markFailed(env, fresh, resp.status);
      return { error: new Error(`模型清单鉴权失败 ${resp.status}`) };
    }
    if (!resp.ok) {
      return {
        error: new Error(`模型清单 HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}`),
      };
    }
    const models = normalizeModels(await resp.json());
    if (!models.length) return { error: new Error("模型清单为空") };
    return { models };
  } catch (e) {
    return { error: e };
  }
}

async function fetchModels(env) {
  const candidates = (await candidateAccounts(env, new Set())).slice(0, MAX_ACCOUNTS);
  if (!candidates.length) throw new Error("没有可用账号");
  const results = await Promise.all(candidates.map((acct) => fetchOne(env, acct)));
  const lists = results.filter((r) => r.models).map((r) => r.models);
  if (!lists.length) {
    throw results.find((r) => r.error)?.error || new Error("无法获取模型清单");
  }
  return mergeModels(...lists);
}

export async function getModels(env, force = false, sync = false) {
  const now = Date.now();

  // 管理页面读取：始终回源 KV，保证换 isolate / 刷新页面后仍然是同一份强制刷新结果
  if (sync) {
    const stored = await readStored(env);
    if (stored) return setCache(stored.models, stored.at || now);
  }

  if (!force && cache.models.length && now - cache.at < TTL_MS) return cache;

  let stored = null;
  if (!force) {
    stored = await readStored(env);
    if (stored) {
      setCache(stored.models, stored.at || now);
      if (now - (stored.at || 0) < KV_TTL_MS) return cache;
    }
  }

  try {
    const fresh = await fetchModels(env);
    const models = force ? fresh : mergeModels(stored?.models || [], fresh);
    return await storeModels(env, models);
  } catch (e) {
    const fallback = await readStored(env);
    if (fallback) return setCache(fallback.models, fallback.at || now);
    if (cache.models.length) return cache;
    throw e;
  }
}

export function modelsUpdatedAt() {
  return cache.updatedAt || 0;
}

export function resolveModel(name) {
  const raw = String(name || "").trim();
  const low = raw.toLowerCase();
  if (!low || low === "default" || low === "auto") {
    return cache.models.find((m) => m.default) || cache.models[0] || null;
  }
  return cache.byKey.get(raw) || cache.alias.get(low) || cache.alias.get(slug(raw)) || null;
}

export function fallbackModel(name) {
  return {
    key: String(name || "auto"),
    source: "system",
    name: String(name || "auto"),
    reasoning: false,
    vision: false,
    default: false,
    enabled: true,
    ctx: 200000,
    max_output_tokens: 32000,
    format: "openai",
    thinking_config: null,
  };
}

function publicEntry(id, model, now, extra = {}) {
  return {
    id,
    object: "model",
    created: now,
    owned_by: "qoder",
    name: model.name,
    context_length: model.ctx,
    max_output_tokens: model.max_output_tokens,
    reasoning: model.reasoning,
    vision: model.vision,
    ...extra,
  };
}

export function publicModelList(routes = null) {
  const now = Math.floor(Date.now() / 1000);
  const byId = new Map();
  for (const m of cache.models) {
    if (!m.enabled) continue;
    byId.set(m.key.toLowerCase(), publicEntry(m.key, m, now));
  }
  if (routes) {
    const add = (source, target, kind, replace) => {
      const id = String(source || "").trim();
      if (!id) return;
      const low = id.toLowerCase();
      if (!replace && byId.has(low)) return;
      const model = resolveModel(target);
      if (!model) return;
      byId.set(low, publicEntry(id, model, now, { route: kind, target: model.key }));
    };
    for (const [source, target] of Object.entries(routes.mappings || {})) {
      add(source, target, "mapping", true);
    }
    for (const [source, target] of Object.entries(routes.aliases || {})) {
      add(source, target, "alias", false);
    }
  }
  return [...byId.values()].sort(
    (a, b) => (b.context_length || 0) - (a.context_length || 0) || String(a.id).localeCompare(String(b.id))
  );
}
