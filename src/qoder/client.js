// Qoder 国际版上游客户端：v3 请求体、SSE 解包、token 续期、每日签到。
import { CosyContext, DEFAULT_OPENAPI, uuidV5 } from "./cosy.js";

export const REFRESH_PATH = "/api/v1/deviceToken/refresh";
export const CAMPAIGNS_PATH = "/sash/api/v1/me/campaigns";
export const USAGE_PATH = "/sash/api/v2/me/usage";
export const MODEL_LIST_PATH = "/algo/api/v2/model/list";
export const REFRESH_AHEAD_SEC = 86400;
export const FAIL_COOLDOWN_SEC = 300;
export const SESSION_TYPE = "qodercli";
export const BUSINESS_TYPE = "agent";
export const BUSINESS_PRODUCT = "cli";

const EFFORT_BUDGETS = { none: 0, low: 1024, medium: 8192, high: 24576, xhigh: 49152, max: 65536 };
const EFFORT_ALIASES = { disabled: "none", off: "none", minimal: "low" };

export function parseExp(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  if (typeof value !== "string") return null;
  const m = value.match(
    /(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})?/
  );
  if (!m) return null;
  let base = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) / 1000;
  if (m[7] && m[7] !== "Z") {
    const sign = m[7][0] === "+" ? 1 : -1;
    const tz = m[7].slice(1).replace(":", "");
    base -= sign * (Number(tz.slice(0, 2)) * 3600 + Number(tz.slice(2, 4) || 0) * 60);
  }
  return base;
}

function effortOfBudget(n) {
  if (n <= 0) return "none";
  if (n <= 1024) return "low";
  if (n <= 8192) return "medium";
  if (n <= 24576) return "high";
  if (n <= 49152) return "xhigh";
  return "max";
}

function normEffort(v) {
  if (v === null || v === undefined || typeof v === "boolean") return null;
  if (typeof v === "number") return effortOfBudget(v);
  const s = String(v).trim().toLowerCase();
  const e = EFFORT_ALIASES[s] || s;
  return Object.prototype.hasOwnProperty.call(EFFORT_BUDGETS, e) ? e : null;
}

function thinkingInputs(body) {
  let effort = normEffort(body.reasoning_effort);
  let budget =
    typeof body.reasoning_budget_tokens === "number" ? body.reasoning_budget_tokens : undefined;
  if (budget === undefined && typeof body.thinking_budget === "number") budget = body.thinking_budget;
  let enable = typeof body.enable_thinking === "boolean" ? body.enable_thinking : null;
  const preserve = typeof body.preserve_thinking === "boolean" ? body.preserve_thinking : null;
  const r = body.reasoning;
  if (r && typeof r === "object") {
    if (effort === null) effort = normEffort(r.effort);
    if (enable === null && typeof r.enabled === "boolean") enable = r.enabled;
    const rb = r.budgetTokens ?? r.budget_tokens;
    if (budget === undefined && typeof rb === "number") budget = rb;
  }
  const t = body.thinking;
  if (t && typeof t === "object") {
    const typ = String(t.type || "").trim().toLowerCase();
    if (enable === null && (typ === "enabled" || typ === "disabled" || typ === "off")) {
      enable = typ === "enabled";
    }
    const tb = t.budget_tokens ?? t.budgetTokens;
    if (budget === undefined && typeof tb === "number") budget = tb;
  }
  if (effort === null && budget !== undefined) effort = effortOfBudget(budget);
  if (effort === null && enable === false) effort = "none";
  return { effort, budget, enable, preserve };
}

function allowedEfforts(model) {
  const tc = model?.thinking_config;
  if (!tc || typeof tc !== "object") return null;
  const allowed = [];
  const effs = tc.enabled?.efforts;
  if (effs && typeof effs === "object") {
    for (const k of Object.keys(effs)) {
      const e = normEffort(k);
      if (e && e !== "none" && !allowed.includes(e)) allowed.push(e);
    }
  }
  if ("disabled" in tc && tc.disabled !== null && tc.disabled !== false && !allowed.includes("none")) {
    allowed.push("none");
  }
  allowed.sort((a, b) => EFFORT_BUDGETS[a] - EFFORT_BUDGETS[b]);
  return allowed;
}

function clampEffort(effort, allowed) {
  const cands = effort === "none" ? [...allowed] : allowed.filter((a) => a !== "none");
  if (!cands.length) return null;
  return cands.reduce((best, a) => {
    const da = Math.abs(EFFORT_BUDGETS[a] - EFFORT_BUDGETS[effort]);
    const db = Math.abs(EFFORT_BUDGETS[best] - EFFORT_BUDGETS[effort]);
    return da < db || (da === db && EFFORT_BUDGETS[a] < EFFORT_BUDGETS[best]) ? a : best;
  });
}

function thinkingUpstream(oa, model) {
  let { effort, budget, enable, preserve } = thinkingInputs(oa);
  if (effort === null && budget === undefined && enable === null && preserve === null) {
    return { effort: null, params: null };
  }
  const allowed = allowedEfforts(model);
  if (effort !== null && allowed !== null && !allowed.includes(effort)) {
    const clamped = clampEffort(effort, allowed);
    if (clamped === null) return { effort: null, params: null };
    effort = clamped;
    budget = undefined;
  }
  const params = {};
  if (effort !== null) {
    params.reasoning_effort = effort;
    if (effort === "none") {
      enable = false;
      budget = undefined;
    } else {
      enable = true;
    }
  }
  if (enable !== null) params.enable_thinking = enable;
  if (typeof budget === "number" && budget > 0) params.reasoning_budget_tokens = Math.trunc(budget);
  if (preserve !== null) params.preserve_thinking = preserve;
  return { effort, params };
}

function contentText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts = [];
    for (const p of content) {
      if (typeof p === "string") parts.push(p);
      else if (p && typeof p.text === "string") parts.push(p.text);
    }
    return parts.join("\n");
  }
  return "";
}

export function sessionIdOf(account) {
  const label = account.label || account.account || "";
  const seed = account.session_seed || "";
  return uuidV5(`qoder-intl-proxy:${label}:${seed}`);
}

export function buildInferPayload(oa, model, account) {
  const mid = crypto.randomUUID();
  const messages = Array.isArray(oa.messages) ? oa.messages : [];
  const { effort, params: thinkParams } = thinkingUpstream(oa, model);
  const isReasoning = Boolean(model.reasoning) && effort !== "none";

  let userText = "";
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m.role === "user") {
      userText = contentText(m.content);
      break;
    }
  }
  const systemText = messages
    .filter((m) => m && m.role === "system")
    .map((m) => contentText(m.content))
    .join("\n\n");

  const params = {};
  for (const key of ["temperature", "top_p", "tool_choice"]) {
    if (oa[key] !== undefined && oa[key] !== null) params[key] = oa[key];
  }
  let maxTokens = oa.max_tokens;
  if (!Number.isInteger(maxTokens) || maxTokens <= 0) {
    maxTokens = Number(model.max_output_tokens) || 32000;
  }
  params.max_tokens = maxTokens;
  if (oa.parameters && typeof oa.parameters === "object") Object.assign(params, oa.parameters);
  if (thinkParams) Object.assign(params, thinkParams);

  return {
    request_id: mid,
    request_set_id: mid,
    chat_record_id: mid,
    session_id: sessionIdOf(account),
    stream: true,
    chat_task: "FREE_INPUT",
    chat_context: {
      text: userText,
      features: [],
      extra: {
        context: [],
        modelConfig: { key: model.key, is_reasoning: isReasoning },
        originalContent: userText,
      },
      chatPrompt: "",
      imageUrls: null,
    },
    is_reply: true,
    is_retry: false,
    source: 1,
    version: "3",
    agent_id: "agent_common",
    task_id: "common",
    session_type: SESSION_TYPE,
    aliyun_user_type: "",
    model_config: {
      key: model.key,
      display_name: model.name || model.key,
      model: "",
      format: model.format || "openai",
      is_vl: Boolean(model.vision),
      is_reasoning: isReasoning,
      api_key: "",
      url: "",
      source: model.source || "system",
      max_input_tokens: Number(model.ctx) || 200000,
    },
    system: systemText,
    messages,
    tools: Array.isArray(oa.tools) ? oa.tools : [],
    parameters: params,
    business: { type: BUSINESS_TYPE, product: BUSINESS_PRODUCT },
  };
}

export function accountAuth(account) {
  let tags = account.organization_tags;
  if (typeof tags === "string") {
    try {
      tags = JSON.parse(tags);
    } catch {
      tags = [];
    }
  }
  return {
    uid: account.uid || "",
    token: account.token || "",
    machineId: account.machine_id || "",
    cosyVersion: account.cosy_version || "1.1.69",
    organizationId: account.organization_id || "",
    organizationTags: Array.isArray(tags) ? tags : [],
    dataPolicyAgreed: Boolean(account.data_policy_agreed),
  };
}

function upstreamHeadersFor(model) {
  return { model: model.key, source: model.source || "system" };
}

export async function signedFetchInfer(account, oa, model, gateway) {
  const ctx = await CosyContext.fromAccount(accountAuth(account));
  const payload = buildInferPayload(oa, model, account);
  const { model: modelKey, source } = upstreamHeadersFor(model);
  const req = ctx.prepareInferRequest(gateway, JSON.stringify(payload), modelKey, source);
  const resp = await fetch(req.url, {
    method: "POST",
    headers: req.headers,
    body: req.body,
    signal: AbortSignal.timeout(600000),
  });
  return resp;
}

export async function signedFetchModels(account, gateway) {
  const ctx = await CosyContext.fromAccount(accountAuth(account));
  const req = ctx.prepareRequest(gateway, MODEL_LIST_PATH, { method: "GET" });
  const resp = await fetch(req.url, {
    method: "GET",
    headers: req.headers,
    signal: AbortSignal.timeout(30000),
  });
  return resp;
}

// ── SSE 解包 ─────────────────────────────────────────────────────────────────
export function unwrapFrame(text) {
  if (text === null || text === undefined) return null;
  const s = String(text).trim();
  if (s === "[DONE]") return "[DONE]";
  let obj;
  try {
    obj = JSON.parse(s);
  } catch {
    return s;
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return s;
  if ("body" in obj && ("statusCodeValue" in obj || "headers" in obj)) {
    const code = obj.statusCodeValue;
    if (Number.isInteger(code) && code >= 400) {
      return JSON.stringify({
        error: { message: String(obj.body || "").slice(0, 400), type: "upstream_error", code },
      });
    }
    const inner = obj.body;
    if (typeof inner === "string") return inner.trim() || null;
    return JSON.stringify(inner);
  }
  return s;
}

// 逐帧读取上游 SSE；帧内容为解包后的 JSON 字符串，[DONE] 结束。
export class FrameReader {
  constructor(body) {
    this.reader = body.getReader();
    this.decoder = new TextDecoder();
    this.buf = "";
    this.parts = [];
    this.done = false;
  }

  async next() {
    while (!this.done) {
      let idx = this.buf.indexOf("\n");
      if (idx >= 0) {
        const line = this.buf.slice(0, idx).replace(/\r$/, "");
        this.buf = this.buf.slice(idx + 1);
        if (line.startsWith("data:")) {
          this.parts.push(line.slice(5).trim());
        } else if (line.trim() === "") {
          if (!this.parts.length) continue;
          const text = unwrapFrame(this.parts.join("\n"));
          this.parts = [];
          if (text === "[DONE]") {
            this.done = true;
            return { done: true };
          }
          if (text) return { done: false, value: text };
        }
        continue;
      }
      if (this.buf.length > 32 * 1024 * 1024) {
        this.done = true;
        return { done: true };
      }
      const { done, value } = await this.reader.read();
      if (done) {
        this.done = true;
        const tail = this.buf.trim();
        if (tail.startsWith("data:")) this.parts.push(tail.slice(5).trim());
        if (this.parts.length) {
          const text = unwrapFrame(this.parts.join("\n"));
          this.parts = [];
          if (text && text !== "[DONE]") return { done: false, value: text };
        }
        return { done: true };
      }
      this.buf += this.decoder.decode(value, { stream: true });
    }
    return { done: true };
  }

  async close() {
    this.done = true;
    try {
      await this.reader.cancel();
    } catch {
      // 上游已结束
    }
  }
}

export function errorOf(obj) {
  if (!obj || typeof obj !== "object") return null;
  if (obj.error) {
    return typeof obj.error === "string" ? { message: obj.error } : obj.error;
  }
  if (obj.error_code) {
    return { message: obj.error_msg || obj.message || "", code: obj.error_code };
  }
  return null;
}

export function newChatId() {
  return "chatcmpl-" + crypto.randomUUID().replace(/-/g, "");
}

export function aggregateFrames(frames, modelName) {
  const objs = [];
  for (const f of frames) {
    try {
      const o = typeof f === "string" ? JSON.parse(f) : f;
      if (o && typeof o === "object" && !Array.isArray(o)) objs.push(o);
    } catch {
      // 非 JSON 帧直接丢弃
    }
  }
  if (objs.length && objs[0].object === "chat.completion") return objs[0];

  const text = [];
  const reasoning = [];
  const tools = {};
  let usage = null;
  let finish = null;
  let role = "assistant";
  let cid = newChatId();
  let created = Math.floor(Date.now() / 1000);
  let model = modelName;
  let got = false;

  for (const c of objs) {
    if (errorOf(c)) return { error: c };
    if (c.usage) {
      usage = c.usage;
      got = true;
    }
    if (c.id) cid = c.id;
    if (c.created) created = c.created;
    if (c.model) model = c.model;
    for (const ch of c.choices || []) {
      got = true;
      if (ch.finish_reason) finish = ch.finish_reason;
      const d = ch.delta || {};
      if (d.role) role = d.role;
      if (d.content) text.push(d.content);
      if (d.reasoning_content) reasoning.push(d.reasoning_content);
      for (const tc of d.tool_calls || []) {
        const slot = (tools[tc.index || 0] ||= { id: "", name: "", args: "" });
        if (tc.id) slot.id = tc.id;
        const fn = tc.function || {};
        if (fn.name) slot.name = slot.name && fn.name !== slot.name ? slot.name + fn.name : fn.name;
        if (fn.arguments) slot.args += fn.arguments;
      }
    }
  }

  if (!got) {
    return {
      id: newChatId(),
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: modelName,
      choices: [
        { index: 0, message: { role: "assistant", content: null }, finish_reason: "stop" },
      ],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    };
  }

  const message = { role, content: text.join("") || null };
  if (reasoning.length) message.reasoning_content = reasoning.join("");
  if (Object.keys(tools).length) {
    message.tool_calls = Object.entries(tools)
      .sort((a, b) => Number(a[0]) - Number(b[0]))
      .map(([, s]) => ({
        id: s.id || "call_" + crypto.randomUUID().replace(/-/g, ""),
        type: "function",
        function: { name: s.name, arguments: s.args || "{}" },
      }));
  }
  return {
    id: cid,
    object: "chat.completion",
    created,
    model,
    choices: [{ index: 0, message, finish_reason: finish || "stop" }],
    usage: usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

// ── openapi（明文 Bearer，不签名）───────────────────────────────────────────
// 签到请求形态常量（对齐 Qoder 桌面客户端 App 0.4.8 逆向规格，
// llm-proxy/reverse_asar_findings.md §1/§2/附录 C）：
// - Cosy-Version 用桌面 App 版本号（app.getVersion()），不是 CLI 版本号；
// - campaigns/usage GET 由主进程 nativeHttpService 发出，UA 字面量 "Qoder"；
// - claim POST 由 campaign H5 iframe 发出，走 Electron session 默认 UA；
// - GATEWAY_UA 为网关自身默认 UA（登录/续期等非签到请求保持不动）。
export const CLIENT_APP_VERSION = "0.4.8";
export const CAMPAIGN_LIST_UA = "Qoder";
export const CLAIM_ELECTRON_UA = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) qoder/${CLIENT_APP_VERSION} Chrome/143.0.0.0 Electron/43.1.1 Safari/537.36`;
const GATEWAY_UA = "qoder-cf-gw/0.1";

export async function openapiJson(env, method, path, { body, token, headers, userAgent } = {}) {
  const base = (env.QODER_OPENAPI || DEFAULT_OPENAPI).replace(/\/+$/, "");
  const h = { Accept: "application/json", "User-Agent": userAgent || GATEWAY_UA };
  if (body !== undefined) h["Content-Type"] = "application/json";
  if (token) h.Authorization = `Bearer ${token}`;
  if (headers) {
    for (const [k, v] of Object.entries(headers)) {
      if (v !== null && v !== undefined && v !== "") h[k] = String(v);
    }
  }
  try {
    const resp = await fetch(base + path, {
      method,
      headers: h,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    });
    const raw = await resp.text();
    let obj = {};
    try {
      obj = raw.trim() ? JSON.parse(raw) : {};
    } catch {
      obj = { message: raw.slice(0, 500) };
    }
    return { status: resp.status, data: obj };
  } catch (e) {
    return { status: 0, data: { message: `网络错误: ${e?.message || e}` } };
  }
}

// NYe 头值校验（逆向报告 §1.3）：Cosy-* 值 trim 后非空且全为可打印 ASCII
// （\x20-\x7e）才发送，否则整头丢弃（不发空值/非法值）。返回 trim 后待发送
// 的值，或 null 表示该头应丢弃。
function cosyHeaderValueOk(v) {
  const s = v === null || v === undefined ? "" : String(v).trim();
  return s !== "" && /^[\x20-\x7e]+$/.test(s) ? s : null;
}

// Cosy-MachineHostname 取值（对齐桌面端 os.hostname()，报告 §4）：账号字段
// machine_hostname 优先（trim 后非空才认）；缺省时确定性生成
// "DESKTOP-" + machine_id 去连字符后前 8 个字符大写（模拟 Windows 主机名形态、
// 可打印 ASCII、与账号绑定稳定）；两者皆缺返回空串（头按 NYe 规则丢弃，
// 等价桌面端 hostname 为空时不发送该头）。
export function machineHostnameOf(account) {
  const explicit = String(account.machine_hostname || "").trim();
  if (explicit) return explicit;
  const hex8 = String(account.machine_id || "").replace(/-/g, "").slice(0, 8);
  return hex8 ? `DESKTOP-${hex8.toUpperCase()}` : "";
}

export function deviceHeaders(account) {
  const raw = {
    "Cosy-Version": account.cosy_version || CLIENT_APP_VERSION,
    "Cosy-ClientType": "10",
    "Cosy-MachineOS": "x86_64_win32",
    "Cosy-MachineHostname": machineHostnameOf(account),
    "Cosy-MachineId": account.machine_id || "",
    "Cosy-MachineToken": account.machine_token || account.machine_id || "",
    "Cosy-MachineType": String(account.machine_type || "5"),
    "Cosy-MachineCode": account.machine_code || "",
  };
  // NYe 校验：非法头整头丢弃（见 cosyHeaderValueOk），合法头发 trim 后的值。
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    const val = cosyHeaderValueOk(v);
    if (val !== null) out[k] = val;
  }
  return out;
}


export async function refreshAccount(env, account) {
  const rt = account.refresh_token;
  if (!rt) return { ok: false, account, error: "没有 refresh_token" };
  const body = { refresh_token: rt };
  // 续期认设备：用签发这套 token 的那台机器的身份，而不是池里给这个号发的独立指纹
  const mid = account.login_machine_id || account.machine_id;
  const mtoken = account.login_machine_token || account.machine_token;
  if (mid) body.machine_id = mid;
  if (mtoken) body.machine_token = mtoken;
  const { status, data } = await openapiJson(env, "POST", REFRESH_PATH, { body });
  const token = data?.device_token || data?.token;
  if (status === 200 && token) {
    const expiresAt = data.expires_at || account.expires_at || "";
    return {
      ok: true,
      patch: {
        token,
        refresh_token: data.refresh_token || account.refresh_token,
        expires_at: expiresAt,
        refresh_expires_at:
          data.refresh_token_expires_at || account.refresh_expires_at || "",
        exp: parseExp(expiresAt) || Math.floor(Date.now() / 1000) + 30 * 86400,
        refresh_dead: 0,
        failed_at: 0,
        failed_status: 0,
      },
    };
  }
  if ([400, 401, 403].includes(status)) {
    return {
      ok: false,
      dead: true,
      patch: {
        refresh_dead: 1,
        refresh_error: `${status} ${JSON.stringify(data)}`.slice(0, 200),
      },
      error: `续期被拒 ${status}`,
    };
  }
  return { ok: false, error: `续期失败 ${status}` };
}

// ── 每日签到（国内版方式）─────────────────────────────────────────────────────
// 行为对齐国内版 qoder_proxy.py（服务器上实战验证：所有账号连续多天全部正常领取）：
// 1. 设备头一律用账号池身份 deviceHeaders（等价国内版 _cosy_device_headers）：
//    每号独立 machine_id，machine_token 空时用 machine_id 顶替（上游不校验两者
//    对应关系），Cosy-ClientType=10（桌面端，5 时列表恒为空）。
// 2. 只领列表里 actionType=CLAIM_BENEFIT 且 claimStatus=CLAIMABLE 且有
//    campaignId 的条目（claimableCampaigns，等价 _claimable_campaigns）：不限
//    当日、不限 benefit.kind；按项筛才不会把 VIEW_DETAILS 当成奖励去 POST。
//    列表没有可领条目就是成功 no-op（之前领过 / 未到窗口或活动已结束），
//    不盲领、不探测。
// 3. claim 幂等：同账号重复 POST 返回 replayed:true 不二次发放，整条链路可
//    随便重试。
// 4. SAME_PERSON_ALREADY_CLAIMED（HTTP 200 + BLOCKED）：国内版 qoder_proxy.py
//    用账号池身份（每号独立 machineId，machineToken 空时用 machineId 顶替，
//    上游不校验两者对应关系）在服务器上连续多天全部账号正常领取；2026-10-20
//    国际版线上失败的根因是当年导入的账号全部共用本机客户端共享 machineId
//    （02ab95d6）且 machine_token 空。修复 = 签到用账号池身份（本实现）+
//    把每个账号的独立 machineId 同步到线上（PATCH /api/accounts/:id）。
//    回执判定上它 HTTP 200 属 2xx：国内版 all(2xx) 即成功不报错；本实现
//    per-item interpretClaim 对它同样 ok=true 不报错，多目标时 ok = 所有回执
//    全 ok，语义与国内版一致。
// 5. 请求形态按桌面客户端 0.4.8 逆向规格对齐（reverse_asar_findings.md）：
//    Cosy-Version 默认 App 版本 0.4.8（account.cosy_version 优先）、补
//    Cosy-MachineHostname（account.machine_hostname 优先，缺省由 machine_id
//    确定性生成）、campaigns/usage GET 用 UA "Qoder"、claim POST 用 Electron
//    UA、所有 Cosy-* 头经 NYe 校验（trim 后非空且可打印 ASCII，否则整头丢弃）。
const CLAIM_RECEIPT_KEYS = ["grantId", "claimedAt", "grantedAt", "replayed", "failureCode"];

export function campaignId(c) {
  return String(c.id || c.campaignId || c.campaign_id || "");
}

export function isCreditsBenefit(c) {
  return (
    c.actionType === "CLAIM_BENEFIT" &&
    String(c.benefit?.kind || "").toUpperCase() === "CREDITS"
  );
}

// 真正要领的那几项（对齐国内版 _claimable_campaigns）：actionType=CLAIM_BENEFIT
// 且 claimStatus=CLAIMABLE 且有 campaignId 的全部条目——不限当日、不限
// benefit.kind。顶层 claimable 只是“有没有份”的总开关，不区分是哪个活动；
// 已领过的项 claimStatus 会变成 CLAIMED，所以按项筛才不会把 VIEW_DETAILS
// 当成奖励去 POST。
export function claimableCampaigns(cps) {
  return (cps || []).filter(
    (c) =>
      c &&
      typeof c === "object" &&
      campaignId(c) &&
      c.actionType === "CLAIM_BENEFIT" &&
      c.claimStatus === "CLAIMABLE"
  );
}

function creditsSecured(cps) {
  return cps.some((c) => isCreditsBenefit(c) && c.claimStatus === "CLAIMED");
}

export async function addOnTotal(env, account) {
  const { status, data } = await openapiJson(env, "GET", USAGE_PATH, {
    token: account.token,
    headers: deviceHeaders(account),
    userAgent: CAMPAIGN_LIST_UA, // usage 同为主进程 native openapi 请求（UA "Qoder"）
  });
  if (status !== 200 || !data || typeof data !== "object") return null;
  const q = data.qoderUsage && typeof data.qoderUsage === "object" ? data.qoderUsage : data;
  const total = q.addOnQuota?.total;
  return typeof total === "number" ? total : null;
}

// claim 回执解读（纯函数便于单测）。入参为收进 rep.claimed 的回执条目，返回
// { secured, ok, message?, error? }：
// - CLAIMED/GRANTED（HTTP 2xx）→ 已发放 secured=true；!replayed 且（GRANTED 或
//   带 grantedAt）视为本轮新领，否则为重放（此前已领，幂等不二次发放）。
// - BLOCKED + SAME_PERSON_ALREADY_CLAIMED → 上游拒发（判定同一身份今日已领），
//   未到账但 ok=true 不算失败：判定按 (uid, campaignId) 缓存，当天重试只重放。
// - 其它 BLOCKED / HTTP 非 2xx / 未知回执 → 失败，error 带上游 message。
export function interpretClaim(item) {
  const st = String(item?.claimStatus || "").toUpperCase();
  const httpOk = [200, 201, 204].includes(Number(item?.status));
  if (httpOk && (st === "CLAIMED" || st === "GRANTED")) {
    const fresh = !item.replayed && (st === "GRANTED" || Boolean(item.grantedAt));
    return {
      secured: true,
      ok: true,
      message: fresh
        ? "今日 100 Credits 本轮已领取"
        : "今日 100 Credits 已到账（此前已领）",
    };
  }
  if (httpOk && st === "BLOCKED" && item.failureCode === "SAME_PERSON_ALREADY_CLAIMED") {
    return {
      secured: false,
      ok: true,
      message:
        "上游拒发：判定同一身份今日已领（SAME_PERSON_ALREADY_CLAIMED），未到账；触发条件待查（桌面端换号可领）",
    };
  }
  return {
    secured: false,
    ok: false,
    error: item?.message || item?.errorMessage || `claim HTTP ${item?.status}`,
  };
}

export async function checkinAccount(env, account) {
  // 设备头一律用账号池身份（国内版方式）：每号独立 machine_id；machine_token
  // 空时 deviceHeaders 自动用 machine_id 顶替（上游不校验两者对应关系）。
  const headers = deviceHeaders(account);
  const rep = { status: 0, campaigns: 0, claimable: false, claimed: [], secured: false };
  const list = await openapiJson(env, "GET", CAMPAIGNS_PATH, {
    token: account.token,
    headers,
    userAgent: CAMPAIGN_LIST_UA, // 客户端 nativeHttpService 的列表 GET（UA 字面量 "Qoder"）
  });
  rep.status = list.status;
  if (list.status !== 200 || !list.data || typeof list.data !== "object") {
    rep.error = list.data?.message || `HTTP ${list.status}`;
    return { ok: false, rep };
  }
  const cps = (list.data.campaigns || []).filter((c) => c && typeof c === "object");
  rep.campaigns = cps.length;
  rep.claimable = Boolean(list.data.claimable);
  rep.secured = creditsSecured(cps);
  const targets = claimableCampaigns(cps);
  if (!targets.length) {
    // 无可领条目 = 成功 no-op（国内版口径）：此前已领 / 未到窗口或活动已结束。
    rep.message = rep.secured
      ? "今天的 Credits 已在手上（之前领过）"
      : "当前没有可领取的活动（未到窗口或活动已结束）";
    return { ok: true, rep };
  }
  // 循环逐个 POST claim（对齐国内版 for 循环）：claim 幂等（重复 POST 返回
  // replayed:true 不二次发放）重试安全；每个目标的回执都收进 rep.claimed。
  for (const target of targets) {
    const cid = campaignId(target);
    const claim = await openapiJson(env, "POST", `${CAMPAIGNS_PATH}/${encodeURIComponent(cid)}/claim`, {
      body: {},
      token: account.token,
      headers,
      userAgent: CLAIM_ELECTRON_UA, // claim 由 campaign H5 iframe 发出，走 Electron session 默认 UA
    });
    const item = {
      id: cid,
      status: claim.status,
      key: target.campaignKey,
      kind: target.benefit?.kind,
      amount: target.benefit?.amount,
    };
    if (claim.data && typeof claim.data === "object") {
      for (const k of CLAIM_RECEIPT_KEYS) if (k in claim.data) item[k] = claim.data[k];
      if (claim.data.status !== undefined) item.claimStatus = claim.data.status;
      for (const k of ["message", "code", "success"]) if (k in claim.data) item[k] = claim.data[k];
      if (claim.data.benefit && typeof claim.data.benefit === "object") {
        item.kind = claim.data.benefit.kind || item.kind;
        item.amount = claim.data.benefit.amount ?? item.amount;
      }
    }
    rep.claimed.push(item);
  }
  // 领后重读列表更新 secured（对齐国内版领后重读）。
  const after = await openapiJson(env, "GET", CAMPAIGNS_PATH, {
    token: account.token,
    headers,
    userAgent: CAMPAIGN_LIST_UA,
  });
  rep.after = { status: after.status, claimable: Boolean(after.data?.claimable) };
  if (after.status === 200) {
    const cps2 = (after.data?.campaigns || []).filter((c) => c && typeof c === "object");
    if (cps2.length) rep.secured = creditsSecured(cps2);
  }
  // 有领过才读最新 addOn 总额（对齐国内版 L598-599：回执之外的“真到手”证据）。
  if (rep.claimed.length) rep.addOnTotal = await addOnTotal(env, account);
  // 回执解读定成败：per-item interpretClaim，全部 ok 才算成功（与国内版
  // all(HTTP 2xx) 语义一致，SAME_PERSON 回执 HTTP 200 不报错）；列表有延迟时
  // 以回执为准（任一回执 secured 即视为已到账）。
  const verdicts = rep.claimed.map(interpretClaim);
  const fail = verdicts.find((v) => !v.ok);
  const win = verdicts.find((v) => v.secured);
  rep.secured = rep.secured || Boolean(win);
  if (fail) {
    rep.error = fail.error;
    rep.message = rep.error;
  } else {
    rep.message = win ? win.message : verdicts[0].message;
  }
  return { ok: !fail, rep };
}

// ── 模型清单 ─────────────────────────────────────────────────────────────────
function maxCtx(cfg) {
  let best = 0;
  if (cfg && typeof cfg === "object") {
    for (const v of Object.values(cfg)) {
      if (v && typeof v === "object" && typeof v.token_count === "number") {
        best = Math.max(best, Math.trunc(v.token_count));
      }
    }
  }
  return best;
}

export function normalizeModels(raw) {
  const out = [];
  for (const scene of ["chat", "developer", "assistant"]) {
    const list = raw?.[scene];
    if (!Array.isArray(list)) continue;
    for (const m of list) {
      if (!m || typeof m !== "object" || !m.key) continue;
      if (out.some((x) => x.key === m.key)) continue;
      out.push({
        key: m.key,
        source: m.source || "system",
        name: m.display_name || m.key,
        reasoning: Boolean(m.is_reasoning),
        vision: Boolean(m.is_vl),
        default: Boolean(m.is_default),
        enabled: m.enable !== false,
        ctx: Math.max(Number(m.max_input_tokens) || 0, maxCtx(m.context_config)),
        max_output_tokens: Number(m.max_output_tokens) || 0,
        format: m.format || "openai",
        scene,
        thinking_config: m.thinking_config && typeof m.thinking_config === "object" ? m.thinking_config : null,
      });
    }
  }
  return out;
}
