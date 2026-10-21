// 本地端到端测试：在 Node 中加载 Worker，用内存 KV/DO 模拟绑定，直连真实 Qoder 上游。
// 用法：QODER_ACCOUNTS_FILE=../llm-proxy/qoder_intl_accounts.json node test/e2e.local.mjs
import fs from "node:fs";
import path from "node:path";
import worker, { ApiKeyCounter, RefreshLock, UsageCounter } from "../src/index.js";

class MemoryStorage {
  constructor() {
    this.map = new Map();
    this.alarm = null;
  }
  async get(key) {
    return this.map.get(key);
  }
  async put(key, value) {
    this.map.set(key, value);
  }
  async delete(key) {
    return this.map.delete(key);
  }
  async setAlarm(at) {
    this.alarm = at;
  }
  async deleteAlarm() {
    this.alarm = null;
  }
}

function doNamespace(cls) {
  const instances = new Map();
  return {
    idFromName(name) {
      return name;
    },
    get(id) {
      if (!instances.has(id)) {
        instances.set(id, new cls({ storage: new MemoryStorage() }));
      }
      const instance = instances.get(id);
      return {
        fetch: (url, init) => instance.fetch(new Request(url, init)),
      };
    },
  };
}

class MemoryKV {
  constructor() {
    this.map = new Map();
  }
  async get(key, type) {
    const value = this.map.get(key);
    if (value === undefined) return null;
    if (type === "json") return JSON.parse(value);
    return value;
  }
  async put(key, value) {
    this.map.set(key, String(value));
  }
  async delete(key) {
    this.map.delete(key);
  }
}

const pending = [];
const env = {
  KV: new MemoryKV(),
  REFRESH_LOCK: doNamespace(RefreshLock),
  USAGE_COUNTER: doNamespace(UsageCounter),
  KEY_COUNTER: doNamespace(ApiKeyCounter),
  ADMIN_PASSWORD: process.env.ADMIN_PASSWORD || "test-admin",
};
const ctx = { waitUntil: (p) => pending.push(p) };

async function call(pathname, { method = "GET", body, key, admin } = {}) {
  const headers = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (key) headers.Authorization = `Bearer ${key}`;
  if (admin) headers.Authorization = `Bearer ${env.ADMIN_PASSWORD}`;
  const req = new Request(`https://gw.local${pathname}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return worker.fetch(req, env, ctx);
}

async function jsonOf(resp) {
  const text = await resp.text();
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text.slice(0, 500) };
  }
}

let failures = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
  if (!ok) failures++;
}

async function main() {
  const accountsFile = process.env.QODER_ACCOUNTS_FILE;
  if (!accountsFile) throw new Error("QODER_ACCOUNTS_FILE is required");
  const accountsPath = path.resolve(process.cwd(), accountsFile);
  const payload = JSON.parse(fs.readFileSync(accountsPath, "utf8"));

  const health = await call("/health");
  check("GET /health", health.status === 200 && (await health.json()).ok);

  const imported = await call("/api/accounts/import", { method: "POST", admin: true, body: payload });
  const importJson = await jsonOf(imported);
  check("账号导入", imported.status === 200 && importJson.imported + importJson.updated >= 1, JSON.stringify({ imported: importJson.imported, updated: importJson.updated, skipped: importJson.skipped }));

  const accountList = await jsonOf(await call("/api/accounts", { admin: true }));
  check("账号列表", Array.isArray(accountList.accounts) && accountList.accounts.length >= 1, `${accountList.accounts?.length || 0} 个`);
  check("账号不回显 token", !JSON.stringify(accountList).includes("dt-") && !JSON.stringify(accountList).includes("drt"));

  const created = await jsonOf(await call("/api/keys", { method: "POST", admin: true, body: { name: "e2e-local" } }));
  check("创建 API Key", typeof created.key === "string" && created.key.startsWith("sk-"));
  const key = created.key;
  if (!key) throw new Error("没有 API Key，后续测试中止");

  const customValue = "e2e-custom-" + Date.now().toString(36);
  const customCreated = await jsonOf(
    await call("/api/keys", {
      method: "POST",
      admin: true,
      body: { name: "e2e-custom", key: customValue },
    })
  );
  check("自定义 API Key 值", customCreated.key === customValue, customCreated.key === customValue ? "按输入值创建" : JSON.stringify(customCreated));
  const customModels = await call("/v1/models", { key: customValue });
  check("自定义 Key 可调用", customModels.status === 200, `${customModels.status}`);
  const dupCustom = await call("/api/keys", {
    method: "POST",
    admin: true,
    body: { name: "e2e-custom-dup", key: customValue },
  });
  check("重复自定义 Key 被拒绝", dupCustom.status === 409, `${dupCustom.status}`);

  const modelsResp = await call("/v1/models", { key });
  const models = await jsonOf(modelsResp);
  check("GET /v1/models", modelsResp.status === 200 && Array.isArray(models.data) && models.data.length > 0, `${models.data?.length || 0} 个模型`);

  if (models.data?.length) {
    const one = await jsonOf(await call(`/v1/models/${encodeURIComponent(models.data[0].id)}`, { key }));
    check("GET /v1/models/{id}", one.id === models.data[0].id);
  }

  const adminModels1 = await jsonOf(await call("/api/models", { admin: true }));
  const persistedModels = await env.KV.get("models:cache", "json");
  check(
    "模型清单持久化到 KV",
    adminModels1.models?.length > 0 &&
      persistedModels?.models?.length >= adminModels1.models.length &&
      Number(persistedModels?.at) > 0,
    `${adminModels1.models?.length || 0} 个, at=${persistedModels?.at || 0}`
  );

  await new Promise((resolve) => setTimeout(resolve, 1100));
  const adminModels2 = await jsonOf(await call("/api/models", { admin: true }));
  check(
    "刷新页面后清单一致",
    adminModels1.updated_at === adminModels2.updated_at &&
      adminModels1.models?.length === adminModels2.models?.length,
    `updated_at=${adminModels1.updated_at}`
  );

  const forcedModels = await jsonOf(await call("/api/models?refresh=1", { admin: true }));
  check(
    "强制刷新合并账号并持久化",
    forcedModels.models?.length >= adminModels2.models?.length && Number(forcedModels.updated_at) > 0,
    `${forcedModels.models?.length || 0} 个`
  );
  await new Promise((resolve) => setTimeout(resolve, 1100));
  const afterForce = await jsonOf(await call("/api/models", { admin: true }));
  check(
    "强制刷新后仍持久可读",
    afterForce.updated_at === forcedModels.updated_at &&
      afterForce.models?.length === forcedModels.models?.length,
    `updated_at=${forcedModels.updated_at}`
  );

  const rid = modelsResp.headers.get("x-request-id") || "";
  check("X-Request-Id 响应头", /^[0-9a-f-]{36}$/.test(rid), rid);

  const badKeyResp = await call("/v1/models", { key: "sk-invalid" });
  const badKeyJson = await jsonOf(badKeyResp);
  check(
    "无效 Key 401 + request_id",
    badKeyResp.status === 401 &&
      badKeyJson.error?.code === "invalid_api_key" &&
      badKeyJson.error?.request_id === badKeyResp.headers.get("x-request-id"),
    JSON.stringify(badKeyJson.error)
  );

  const expired = await jsonOf(
    await call("/api/keys", {
      method: "POST",
      admin: true,
      body: { name: "e2e-expired", expires_at: Math.floor(Date.now() / 1000) - 60 },
    })
  );
  const expiredResp = await call("/v1/models", { key: expired.key });
  const expiredJson = await jsonOf(expiredResp);
  check(
    "过期 Key 401",
    expiredResp.status === 401 && expiredJson.error?.code === "expired_api_key",
    `${expiredResp.status} ${expiredJson.error?.code || ""}`
  );

  const limited = await jsonOf(
    await call("/api/keys", { method: "POST", admin: true, body: { name: "e2e-quota", max_calls: 2 } })
  );
  const q1 = await call("/v1/models", { key: limited.key });
  const q2 = await call("/v1/models", { key: limited.key });
  const q3 = await call("/v1/models", { key: limited.key });
  const q3Json = await jsonOf(q3);
  check(
    "次数上限：前两次放行，第三次 429",
    q1.status === 200 && q2.status === 200 && q3.status === 429 && q3Json.error?.code === "insufficient_quota",
    `${q1.status}/${q2.status}/${q3.status} ${q3Json.error?.code || ""}`
  );

  const keysNow = await jsonOf(await call("/api/keys", { admin: true }));
  const quotaRow = (keysNow.keys || []).find((k) => k.id === limited.id);
  check(
    "管理端展示 Key 用量",
    quotaRow && quotaRow.used_calls === 2 && quotaRow.max_calls === 2,
    JSON.stringify(quotaRow && { used: quotaRow.used_calls, max: quotaRow.max_calls })
  );

  const patched = await jsonOf(
    await call(`/api/keys/${limited.id}`, { method: "PATCH", admin: true, body: { max_calls: 3 } })
  );
  const q4 = await call("/v1/models", { key: limited.key });
  check("提高上限后恢复", patched.max_calls === 3 && q4.status === 200, `${q4.status}`);

  const reset = await jsonOf(await call(`/api/keys/${limited.id}/reset`, { method: "POST", admin: true }));
  const keysAfterReset = await jsonOf(await call("/api/keys", { admin: true }));
  const resetRow = (keysAfterReset.keys || []).find((k) => k.id === limited.id);
  check("重置 Key 用量", reset.ok === true && resetRow?.used_calls === 0, JSON.stringify(resetRow && { used: resetRow.used_calls }));

  const huge = "x".repeat(4200000);
  const bigChat = await call("/v1/chat/completions", {
    method: "POST",
    key,
    body: { model: "auto", messages: [{ role: "user", content: huge }] },
  });
  const bigChatJson = await jsonOf(bigChat);
  check(
    "上下文预检（OpenAI）",
    bigChat.status === 400 && bigChatJson.error?.code === "context_length_exceeded",
    `${bigChat.status} ${bigChatJson.error?.code || ""}`
  );

  const bigAnth = await call("/v1/messages", {
    method: "POST",
    key,
    body: { model: "auto", max_tokens: 64, messages: [{ role: "user", content: huge }] },
  });
  const bigAnthJson = await jsonOf(bigAnth);
  check(
    "上下文预检（Anthropic）",
    bigAnth.status === 400 && bigAnthJson.error?.type === "invalid_request_error" && /输入过长/.test(bigAnthJson.error?.message || ""),
    `${bigAnth.status} ${bigAnthJson.error?.type || ""}`
  );

  const bigResp = await call("/v1/responses", {
    method: "POST",
    key,
    body: { model: "auto", input: huge },
  });
  const bigRespJson = await jsonOf(bigResp);
  check(
    "上下文预检（Responses）",
    bigResp.status === 400 && bigRespJson.error?.code === "context_length_exceeded",
    `${bigResp.status} ${bigRespJson.error?.code || ""}`
  );

  const anthBadResp = await call("/v1/messages", {
    method: "POST",
    key: "sk-invalid",
    body: { model: "auto", max_tokens: 8, messages: [{ role: "user", content: "hi" }] },
  });
  const anthBadJson = await jsonOf(anthBadResp);
  check(
    "Anthropic 401 错误格式",
    anthBadResp.status === 401 &&
      anthBadJson.type === "error" &&
      anthBadJson.error?.type === "authentication_error" &&
      Boolean(anthBadJson.error?.request_id),
    JSON.stringify(anthBadJson)
  );

  await call(`/api/keys/${expired.id}`, { method: "DELETE", admin: true });
  await call(`/api/keys/${limited.id}`, { method: "DELETE", admin: true });
  if (customCreated.id) await call(`/api/keys/${customCreated.id}`, { method: "DELETE", admin: true });

  const chatBody = {
    model: "auto",
    messages: [
      { role: "system", content: "You are a terse test assistant." },
      { role: "user", content: "Reply with the single word: pong" },
    ],
  };
  const chatResp = await call("/v1/chat/completions", { method: "POST", key, body: chatBody });
  const chat = await jsonOf(chatResp);
  const chatText = chat.choices?.[0]?.message?.content || "";
  check("OpenAI 非流式", chatResp.status === 200 && chatText.length > 0, `${chatResp.status} ${JSON.stringify(chatText).slice(0, 80)}`);

  const parallel = await Promise.all(
    [1, 2, 3].map(() => call("/v1/chat/completions", { method: "POST", key, body: chatBody }))
  );
  check(
    "并发请求 — 3 个同时请求均成功",
    parallel.every((r) => r.status === 200),
    parallel.map((r) => r.status).join("/")
  );

  const streamResp = await call("/v1/chat/completions", { method: "POST", key, body: { ...chatBody, stream: true } });
  const streamText = await streamResp.text();
  check(
    "OpenAI 流式",
    streamResp.status === 200 && streamText.includes("data: [DONE]") && streamText.includes('"chat.completion.chunk"'),
    `${streamResp.status} ${streamText.length} bytes`
  );

  const anthropicBody = {
    model: "auto",
    max_tokens: 64,
    messages: [{ role: "user", content: "Reply with the single word: pong" }],
  };
  const anthResp = await call("/v1/messages", { method: "POST", key, body: anthropicBody });
  const anth = await jsonOf(anthResp);
  check(
    "Anthropic 非流式",
    anthResp.status === 200 && anth.type === "message" && Array.isArray(anth.content) && anth.content.length > 0,
    `${anthResp.status} ${anth.type || ""}`
  );

  const anthStreamResp = await call("/v1/messages", { method: "POST", key, body: { ...anthropicBody, stream: true } });
  const anthStream = await anthStreamResp.text();
  check(
    "Anthropic 流式",
    anthStreamResp.status === 200 && anthStream.includes("event: message_start") && anthStream.includes("event: message_stop"),
    `${anthStreamResp.status} ${anthStream.length} bytes`
  );

  const respResp = await call("/v1/responses", { method: "POST", key, body: { model: "auto", input: "Reply with the single word: pong" } });
  const resp = await jsonOf(respResp);
  check("Responses 非流式", respResp.status === 200 && resp.object === "response", `${respResp.status} ${resp.object || ""}`);

  const respStreamResp = await call("/v1/responses", { method: "POST", key, body: { model: "auto", input: "Reply with the single word: pong", stream: true } });
  const respStream = await respStreamResp.text();
  check(
    "Responses 流式",
    respStreamResp.status === 200 && respStream.includes("response.output_text.delta") && respStream.includes("response.completed"),
    `${respStreamResp.status} ${respStream.length} bytes`
  );

  const tokens = await jsonOf(await call("/v1/messages/count_tokens", { method: "POST", key, body: anthropicBody }));
  check("count_tokens", Number(tokens.input_tokens) > 0, `input_tokens=${tokens.input_tokens}`);

  const accountId = accountList.accounts?.[0]?.id;
  if (accountId) {
    const checkin = await jsonOf(await call(`/api/accounts/${accountId}/checkin`, { method: "POST", admin: true }));
    check("签到", checkin.ok === true, checkin.rep?.secured ? "Credits 已到账" : checkin.rep?.message || "");
  }

  await Promise.allSettled(pending);
  const stats = await jsonOf(await call("/api/stats", { admin: true }));
  check(
    "统计",
    stats.accounts >= 1 && stats.keys >= 1 && Number(stats.today?.requests) >= 3,
    `accounts=${stats.accounts} keys=${stats.keys} requests=${stats.today?.requests} tokens=${stats.today?.total_tokens}`
  );

  console.log(failures ? `\n${failures} 项失败` : "\n全部通过");
  process.exitCode = failures ? 1 : 0;
}

main().catch((e) => {
  console.error("E2E 异常:", e?.stack || e);
  process.exitCode = 1;
});
