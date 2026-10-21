// qoder-cf-gw — Qoder 国际版 → OpenAI / Anthropic / Responses 兼容网关。
import { adminHtml } from "./admin.js";
import {
  accountUsable,
  ensureFresh,
  invalidateAccounts,
  loadAccounts,
  markFailed,
  refreshById,
} from "./accounts.js";
import { UpstreamError, collectChat, openaiSseStream, startChat } from "./chat.js";
import {
  anthropicStreamTransform,
  convertAnthropicToOpenAI,
  convertOpenAIToAnthropic,
  convertOpenAIToResponses,
  convertResponsesToOpenAI,
  estimateAnthropicTokens,
  responsesStreamTransform,
} from "./convert.js";
import { errorPayload, requestIdFor } from "./errors.js";
import { ApiKeyCounter } from "./key-counter.js";
import { getModelRoutes, routeOf, saveModelRoutes } from "./model-routes.js";
import { fallbackModel, getModels, modelsUpdatedAt, publicModelList, resolveModel } from "./models.js";
import {
  CAMPAIGNS_PATH,
  CAMPAIGN_LIST_UA,
  addOnTotal,
  checkinAccount,
  deviceHeaders,
  isCreditsBenefit,
  normalizeModels,
  openapiJson,
  signedFetchModels,
} from "./qoder/client.js";
import {
  consumeKeyQuota,
  createApiKey,
  deleteAccountRecord,
  deleteApiKey,
  getAccount,
  importAccounts,
  latestCheckins,
  listAccounts,
  listApiKeys,
  publicAccount,
  recordUsage,
  resetKeyUsage,
  saveCheckin,
  touchApiKey,
  updateAccount,
  updateApiKey,
  usageSummary,
  verifyApiKey,
} from "./store.js";
import { RefreshLock } from "./refresh-lock.js";
import { checkContext } from "./tokens.js";
import { UsageCounter } from "./usage-counter.js";

export { ApiKeyCounter, RefreshLock, UsageCounter };

const MAX_BODY = 16 * 1024 * 1024;
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, x-api-key, anthropic-version, anthropic-beta, x-request-id",
  "Access-Control-Expose-Headers": "X-Request-Id",
};

function json(obj, status = 200, headers = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...headers },
  });
}

function openaiError(message, status = 400, type = "invalid_request_error", code = null) {
  const body = { error: { message, type } };
  if (code) body.error.code = code;
  return json(body, status, CORS);
}

function anthropicError(message, status = 400, type = "invalid_request_error") {
  return json({ type: "error", error: { type, message } }, status, CORS);
}

function sseResponse(stream) {
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      ...CORS,
    },
  });
}

async function readJson(request) {
  const len = Number(request.headers.get("content-length") || 0);
  if (len > MAX_BODY) throw new UpstreamError("请求体过大", 413, "invalid_request_error");
  try {
    const text = await request.text();
    if (text.length > MAX_BODY) throw new UpstreamError("请求体过大", 413, "invalid_request_error");
    return JSON.parse(text);
  } catch (e) {
    if (e instanceof UpstreamError) throw e;
    throw new UpstreamError("Invalid or missing JSON body", 400, "invalid_request_error");
  }
}

function bearer(request) {
  const auth = request.headers.get("authorization") || "";
  if (auth.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
  return "";
}

async function sha256(text) {
  return new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))
  );
}

async function safeEqual(a, b) {
  if (!a || !b) return false;
  const [ha, hb] = await Promise.all([sha256(a), sha256(b)]);
  let diff = 0;
  for (let i = 0; i < ha.length; i++) diff |= ha[i] ^ hb[i];
  return diff === 0;
}

async function adminAuthorized(request, env) {
  if (!env.ADMIN_PASSWORD) return false;
  return safeEqual(bearer(request), env.ADMIN_PASSWORD);
}

async function apiKeyRow(request, env) {
  const key = bearer(request) || request.headers.get("x-api-key") || "";
  return verifyApiKey(env, key.trim());
}

async function resolveRequestModel(env, name) {
  try {
    await getModels(env);
  } catch {
    // 清单拉不到时按原始模型名透传
  }
  let routed = null;
  try {
    routed = routeOf(await getModelRoutes(env), name);
  } catch {
    // 路由读取失败时按原始模型名处理
  }
  const target = routed ? routed.target : name;
  const found = resolveModel(target);
  if (found) return found;
  if (String(env.STRICT_MODEL_MATCH || "").toLowerCase() === "true") return null;
  return fallbackModel(target);
}

function errorResponse(e, protocol) {
  const p = errorPayload(e, protocol);
  if (protocol === "anthropic") return anthropicError(p.message, p.status, p.type);
  return openaiError(p.message, p.status, p.type, p.code);
}

function authFailure(protocol, message, code) {
  if (protocol === "anthropic") return anthropicError(message, 401, "authentication_error");
  return openaiError(message, 401, "invalid_request_error", code);
}

function quotaFailure(protocol, row, quota) {
  const message = `API Key 调用次数已用尽（${quota.used}/${row.max_calls}），请在管理面板调整上限或重置用量。`;
  if (protocol === "anthropic") return anthropicError(message, 429, "rate_limit_error");
  return openaiError(message, 429, "insufficient_quota", "insufficient_quota");
}

function protocolOf(pathname) {
  return pathname === "/v1/messages" || pathname.startsWith("/v1/messages/")
    ? "anthropic"
    : "openai";
}

async function finalizeResponse(resp, rid, request, url) {
  const headers = new Headers(resp.headers);
  headers.set("X-Request-Id", rid);
  const contentType = headers.get("Content-Type") || "";
  if (resp.status >= 400 && contentType.includes("application/json")) {
    const text = await resp.text().catch(() => "");
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
    if (body && typeof body === "object" && body.error && typeof body.error === "object") {
      body.error.request_id = rid;
    }
    if (resp.status >= 500) {
      const detail = body?.error?.message || text.slice(0, 300) || resp.statusText;
      console.error(`[${rid}] ${request.method} ${url.pathname} -> ${resp.status}: ${detail}`);
    }
    headers.delete("Content-Length");
    return new Response(JSON.stringify(body ?? { error: { message: text.slice(0, 500), request_id: rid } }), {
      status: resp.status,
      headers,
    });
  }
  return new Response(resp.body, { status: resp.status, statusText: resp.statusText, headers });
}

// ── /v1 ─────────────────────────────────────────────────────────────────────
async function handleV1(request, env, ctx, url) {
  if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (url.pathname === "/v1/health") {
    return json({ ok: true, service: "qoder-cf-gw" }, 200, CORS);
  }
  const protocol = protocolOf(url.pathname);
  const keyRow = await apiKeyRow(request, env);
  if (!keyRow) return authFailure(protocol, "Invalid API key", "invalid_api_key");
  const nowSec = Math.floor(Date.now() / 1000);
  if (keyRow.expires_at && keyRow.expires_at <= nowSec) {
    return authFailure(
      protocol,
      `API Key 已于 ${new Date(keyRow.expires_at * 1000).toISOString()} 过期`,
      "expired_api_key"
    );
  }
  const quota = await consumeKeyQuota(env, keyRow);
  if (!quota.ok) {
    console.warn(`quota exceeded key=${keyRow.id} used=${quota.used}/${keyRow.max_calls}`);
    return quotaFailure(protocol, keyRow, quota);
  }
  ctx.waitUntil(touchApiKey(env, keyRow.id, keyRow.last_used_at).catch(() => {}));

  if (request.method === "GET" && (url.pathname === "/v1/models" || url.pathname === "/v1/models/")) {
    try {
      await getModels(env);
      const routes = await getModelRoutes(env).catch(() => null);
      return json({ object: "list", data: publicModelList(routes) }, 200, CORS);
    } catch (e) {
      return openaiError(`无法获取模型清单: ${e.message}`, 502, "api_error", "upstream_error");
    }
  }
  const modelMatch = url.pathname.match(/^\/v1\/models\/(.+)$/);
  if (request.method === "GET" && modelMatch) {
    try {
      await getModels(env);
    } catch {
      // 下方按缓存回答
    }
    const id = decodeURIComponent(modelMatch[1]);
    const routes = await getModelRoutes(env).catch(() => null);
    const found = publicModelList(routes).find((m) => m.id.toLowerCase() === id.toLowerCase());
    if (!found) return openaiError(`Model '${id}' not found`, 404, "invalid_request_error", "model_not_found");
    return json(found, 200, CORS);
  }

  if (request.method !== "POST") {
    return openaiError("Method not allowed", 405, "invalid_request_error");
  }

  if (url.pathname === "/v1/chat/completions") return handleChat(request, env, ctx);
  if (url.pathname === "/v1/responses") return handleResponses(request, env, ctx);
  if (url.pathname === "/v1/messages/count_tokens") return handleCountTokens(request);
  if (url.pathname === "/v1/messages") return handleMessages(request, env, ctx);
  return openaiError("Not found", 404, "invalid_request_error");
}

async function handleChat(request, env, ctx) {
  let body;
  try {
    body = await readJson(request);
  } catch (e) {
    return errorResponse(e, "openai");
  }
  if (!Array.isArray(body.messages)) {
    return openaiError("messages field is required and must be an array.", 400);
  }
  const requested = body.model || "auto";
  const model = await resolveRequestModel(env, requested);
  if (!model) return openaiError(`Model '${requested}' not found`, 404, "invalid_request_error", "model_not_found");
  if (!model.max_output_tokens) model.max_output_tokens = 32000;
  const overflow = checkContext(body, model, env);
  if (overflow) return openaiError(overflow.message, 400, "invalid_request_error", "context_length_exceeded");
  const stream = Boolean(body.stream);

  try {
    if (!stream) {
      const { merged } = await collectChat(env, body, model);
      ctx.waitUntil(recordUsage(env, merged.usage).catch(() => {}));
      return json(merged, 200, CORS);
    }
    const { reader, firstFrame } = await startChat(env, body, model);
    const { stream: sse, done } = openaiSseStream(reader, firstFrame, requested);
    ctx.waitUntil(done.then((usage) => usage && recordUsage(env, usage)).catch(() => {}));
    return sseResponse(sse);
  } catch (e) {
    return errorResponse(e, "openai");
  }
}

async function handleMessages(request, env, ctx) {
  let body;
  try {
    body = await readJson(request);
  } catch (e) {
    return anthropicError(e.message, e.status || 400);
  }
  if (!Array.isArray(body.messages)) return anthropicError("messages field is required and must be an array.");
  const requested = body.model || "auto";
  const model = await resolveRequestModel(env, requested);
  if (!model) return anthropicError(`Model '${requested}' not found`, 404, "not_found_error");
  if (!model.max_output_tokens) model.max_output_tokens = 32000;
  const oa = convertAnthropicToOpenAI(body);
  oa.model = model.key;
  const overflow = checkContext(oa, model, env);
  if (overflow) return anthropicError(overflow.message, 400, "invalid_request_error");
  const stream = Boolean(body.stream);

  try {
    if (!stream) {
      const { merged } = await collectChat(env, oa, model);
      ctx.waitUntil(recordUsage(env, merged.usage).catch(() => {}));
      return json(convertOpenAIToAnthropic(merged, requested, body.stop_sequences), 200, CORS);
    }
    const { reader, firstFrame } = await startChat(env, oa, model);
    const openai = openaiSseStream(reader, firstFrame, requested);
    let recorded = false;
    const record = (usage) => {
      if (recorded || !usage) return;
      recorded = true;
      ctx.waitUntil(recordUsage(env, usage).catch(() => {}));
    };
    const out = anthropicStreamTransform(openai.stream, requested, record);
    ctx.waitUntil(openai.done.then((usage) => usage && record(usage)).catch(() => {}));
    return sseResponse(out);
  } catch (e) {
    return errorResponse(e, "anthropic");
  }
}

async function handleResponses(request, env, ctx) {
  let body;
  try {
    body = await readJson(request);
  } catch (e) {
    return errorResponse(e, "openai");
  }
  if (body.input === undefined) return openaiError("input field is required", 400);
  const requested = body.model || "auto";
  const model = await resolveRequestModel(env, requested);
  if (!model) return openaiError(`Model '${requested}' not found`, 404, "invalid_request_error", "model_not_found");
  if (!model.max_output_tokens) model.max_output_tokens = 32000;
  const oa = convertResponsesToOpenAI(body);
  oa.model = model.key;
  const overflow = checkContext(oa, model, env);
  if (overflow) return openaiError(overflow.message, 400, "invalid_request_error", "context_length_exceeded");
  const stream = Boolean(body.stream);

  try {
    if (!stream) {
      const { merged } = await collectChat(env, oa, model);
      ctx.waitUntil(recordUsage(env, merged.usage).catch(() => {}));
      return json(
        convertOpenAIToResponses(merged, requested, {
          instructions: body.instructions,
          parallel_tool_calls: body.parallel_tool_calls,
          temperature: body.temperature,
          top_p: body.top_p,
          tool_choice: body.tool_choice,
          tools: body.tools,
        }),
        200,
        CORS
      );
    }
    const { reader, firstFrame } = await startChat(env, oa, model);
    const openai = openaiSseStream(reader, firstFrame, requested);
    let recorded = false;
    const record = (usage) => {
      if (recorded || !usage) return;
      recorded = true;
      ctx.waitUntil(recordUsage(env, usage).catch(() => {}));
    };
    const out = responsesStreamTransform(openai.stream, requested, record);
    ctx.waitUntil(openai.done.then((usage) => usage && record(usage)).catch(() => {}));
    return sseResponse(out);
  } catch (e) {
    return errorResponse(e, "openai");
  }
}

async function handleCountTokens(request) {
  let body;
  try {
    body = await readJson(request);
  } catch (e) {
    return anthropicError(e.message, e.status || 400);
  }
  if (!Array.isArray(body.messages)) return anthropicError("messages field is required and must be an array.");
  return json({ input_tokens: estimateAnthropicTokens(body) }, 200, CORS);
}

// ── /admin 与 /api ──────────────────────────────────────────────────────────
async function handleAdmin(request, env, ctx, url) {
  if (url.pathname === "/admin" || url.pathname === "/admin/") {
    return new Response(adminHtml(), {
      headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
    });
  }

  if (url.pathname === "/api/auth/login" && request.method === "POST") {
    let body;
    try {
      body = await readJson(request);
    } catch {
      return json({ error: { message: "请求体无效" } }, 400);
    }
    if (await safeEqual(String(body.password || ""), env.ADMIN_PASSWORD || "")) {
      return json({ ok: true });
    }
    return json({ error: { message: "密码错误" } }, 401);
  }

  if (!(await adminAuthorized(request, env))) {
    return json({ error: { message: "未授权：请用 Bearer <ADMIN_PASSWORD>" } }, 401);
  }

  const parts = url.pathname.split("/").filter(Boolean);
  // /api/accounts...
  if (parts[1] === "accounts") {
    if (request.method === "GET" && parts.length === 2) {
      const rows = await listAccounts(env);
      return json({
        accounts: rows.map(publicAccount),
        checkins: await latestCheckins(env),
      });
    }
    if (request.method === "POST" && parts[2] === "import") {
      const body = await readJson(request);
      const result = await importAccounts(env, body);
      invalidateAccounts();
      return json(result);
    }
    const id = parts[2];
    if (id && request.method === "DELETE" && parts.length === 3) {
      await deleteAccountRecord(env, id);
      invalidateAccounts();
      return json({ ok: true });
    }
    // 线上同步账号独立设备身份：把本地池每号独立的 machine_id/machine_token/
    // machine_type/machine_code 等同步到线上（updateAccount 只认 ACCOUNT_FIELDS
    // 白名单字段），用途是修签到设备头连坐；不动 token/refresh。
    if (id && request.method === "PATCH" && parts.length === 3) {
      const body = await readJson(request);
      const updated = await updateAccount(env, id, body);
      if (!updated) return json({ error: { message: "账号不存在" } }, 404);
      invalidateAccounts();
      return json(publicAccount(updated));
    }
    if (id && request.method === "POST" && parts[3] === "test") {
      const account = await getAccount(env, id);
      if (!account) return json({ error: { message: "账号不存在" } }, 404);
      const fresh = await ensureFresh(env, account);
      const resp = await signedFetchModels(fresh, env.QODER_GATEWAY);
      if ([401, 403].includes(resp.status)) {
        await markFailed(env, fresh, resp.status);
        return json({ error: { message: `鉴权失败 ${resp.status}` } }, 502);
      }
      if (!resp.ok) {
        return json({ error: { message: `上游 HTTP ${resp.status}` } }, 502);
      }
      const raw = await resp.json();
      return json({ ok: true, models: normalizeModels(raw).length });
    }
    if (id && request.method === "POST" && parts[3] === "refresh") {
      const result = await refreshById(env, id);
      const patch = result.patch || {};
      return json({
        ok: Boolean(result.ok),
        expires_at: patch.expires_at || null,
        refresh_dead: Boolean(patch.refresh_dead),
        error: result.error || null,
      });
    }
    if (id && request.method === "POST" && parts[3] === "checkin") {
      const account = await getAccount(env, id);
      if (!account) return json({ error: { message: "账号不存在" } }, 404);
      const fresh = await ensureFresh(env, account);
      const result = await checkinAccount(env, fresh);
      await saveCheckin(env, fresh, result);
      return json(result);
    }
    if (id && request.method === "GET" && parts[3] === "campaigns") {
      const account = await getAccount(env, id);
      if (!account) return json({ error: { message: "账号不存在" } }, 404);
      const fresh = await ensureFresh(env, account);
      const list = await openapiJson(env, "GET", CAMPAIGNS_PATH, {
        token: fresh.token,
        headers: deviceHeaders(fresh),
        userAgent: CAMPAIGN_LIST_UA, // 管理端查看活动列表：与签到同一 native 列表 GET 形态
      });
      const cps = (list.data?.campaigns || []).filter((c) => c && typeof c === "object");
      const daily = cps.find(isCreditsBenefit);
      return json({
        ok: list.status === 200,
        status: list.status,
        claimable: Boolean(list.data?.claimable),
        campaigns: cps.map((c) => ({
          key: c.campaignKey,
          actionType: c.actionType,
          claimStatus: c.claimStatus,
          startAt: c.startAt,
          endAt: c.endAt,
          kind: c.benefit?.kind || null,
          amount: c.benefit?.amount ?? null,
        })),
        daily: daily
          ? { key: daily.campaignKey, claimStatus: daily.claimStatus, amount: daily.benefit?.amount }
          : null,
        promo_only: !daily && cps.length > 0,
        add_on_total: await addOnTotal(env, fresh),
      });
    }
    return json({ error: { message: "Not found" } }, 404);
  }

  if (parts[1] === "keys") {
    if (request.method === "GET" && parts.length === 2) {
      return json({ keys: await listApiKeys(env) });
    }
    if (request.method === "POST" && parts.length === 2) {
      const body = await readJson(request);
      try {
        const created = await createApiKey(env, body.name, body);
        return json(created);
      } catch (e) {
        if (e.status) return json({ error: { message: e.message } }, e.status);
        throw e;
      }
    }
    if (request.method === "PATCH" && parts[2] && parts.length === 3) {
      const body = await readJson(request);
      const updated = await updateApiKey(env, parts[2], body);
      if (!updated) return json({ error: { message: "Key 不存在" } }, 404);
      return json(updated);
    }
    if (request.method === "POST" && parts[2] && parts[3] === "reset") {
      return json(await resetKeyUsage(env, parts[2]));
    }
    if (request.method === "DELETE" && parts[2]) {
      await deleteApiKey(env, parts[2]);
      return json({ ok: true });
    }
    return json({ error: { message: "Not found" } }, 404);
  }

  if (parts[1] === "models" && request.method === "GET") {
    const refresh = url.searchParams.get("refresh") === "1";
    await getModels(env, refresh, !refresh);
    const routes = await getModelRoutes(env).catch(() => null);
    return json({ models: publicModelList(routes), updated_at: modelsUpdatedAt() });
  }

  if (parts[1] === "model-routes") {
    if (request.method === "GET") {
      const routes = await getModelRoutes(env);
      return json({ mappings: routes.mappings, aliases: routes.aliases });
    }
    if (request.method === "PUT") {
      const body = await readJson(request);
      try {
        const routes = await saveModelRoutes(env, body);
        return json({ ok: true, mappings: routes.mappings, aliases: routes.aliases });
      } catch (e) {
        if (e.status) return json({ error: { message: e.message } }, e.status);
        throw e;
      }
    }
    return json({ error: { message: "Not found" } }, 404);
  }

  if (parts[1] === "stats" && request.method === "GET") {
    const [summary, accounts, checkins, keys] = await Promise.all([
      usageSummary(env),
      loadAccounts(env, true),
      latestCheckins(env),
      listApiKeys(env),
    ]);
    let modelCount = 0;
    try {
      modelCount = publicModelList().length;
    } catch {
      modelCount = 0;
    }
    return json({
      today: summary.today,
      trend: summary.trend,
      accounts: accounts.length,
      keys: keys.length,
      models: modelCount,
      checkins,
    });
  }

  return json({ error: { message: "Not found" } }, 404);
}

// ── 定时签到 ────────────────────────────────────────────────────────────────
async function runCheckin(env) {
  const rows = await loadAccounts(env, true);
  if (!rows.length) return;
  const done = await latestCheckins(env);
  const secured = new Set(done.filter((r) => r.secured).map((r) => r.account_id));
  const summary = [];
  for (const account of rows) {
    if (secured.has(account.id) || !accountUsable(account)) continue;
    try {
      const fresh = await ensureFresh(env, account);
      if (fresh.refresh_dead && (!fresh.exp || fresh.exp <= Date.now() / 1000)) continue;
      const result = await checkinAccount(env, fresh);
      await saveCheckin(env, fresh, result);
      summary.push({ id: account.id, ok: result.ok, secured: result.rep?.secured });
    } catch (e) {
      console.log(`checkin failed account=${account.id}: ${e?.message || e}`);
      summary.push({ id: account.id, ok: false });
    }
  }
  if (summary.length) console.log("checkin summary", JSON.stringify(summary));
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const rid = requestIdFor(request);
    let resp;
    try {
      if (request.method === "OPTIONS") {
        resp = new Response(null, { headers: CORS });
      } else if (url.pathname === "/" || url.pathname === "/health") {
        resp = json({ ok: true, service: "qoder-cf-gw", admin: "/admin" }, 200, CORS);
      } else if (url.pathname.startsWith("/v1/")) {
        resp = await handleV1(request, env, ctx, url);
      } else if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/admin")) {
        resp = await handleAdmin(request, env, ctx, url);
      } else {
        resp = json({ error: { message: "Not found" } }, 404, CORS);
      }
    } catch (e) {
      console.error(`[${rid}] unhandled`, e?.stack || e);
      resp = errorResponse(e, protocolOf(url.pathname));
    }
    return finalizeResponse(resp, rid, request, url);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runCheckin(env));
  },
};
