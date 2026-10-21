import test from "node:test";
import assert from "node:assert/strict";
import { businessLimitOf, classifyError, errorPayload, parseUpstreamError, requestIdFor } from "../src/errors.js";
import { checkContext, estimateTextTokens, inputTokenLimit } from "../src/tokens.js";
import {
  CAMPAIGNS_PATH,
  USAGE_PATH,
  accountAuth,
  checkinAccount,
  claimableCampaigns,
  deviceHeaders,
  interpretClaim,
} from "../src/qoder/client.js";
import worker from "../src/index.js";
import { getAccount, importAccounts, listAccounts } from "../src/store.js";

test("token 估算：空串与英文", () => {
  assert.equal(estimateTextTokens(""), 0);
  assert.equal(estimateTextTokens("hello world"), 3);
  assert.equal(estimateTextTokens("a".repeat(400)), 100);
});

test("token 估算：中文按 0.6", () => {
  assert.equal(estimateTextTokens("你好"), 2);
  assert.equal(estimateTextTokens("你好世界"), 3);
});

test("上下文上限：模型 ctx - 输出 - 2% 余量", () => {
  const model = { ctx: 1000000, max_output_tokens: 32000 };
  assert.deepEqual(inputTokenLimit(model, {}), {
    ctx: 1000000,
    maxOut: 32000,
    margin: 20000,
    limit: 948000,
  });
  assert.equal(inputTokenLimit(model, { MAX_INPUT_TOKENS: "500000" }).limit, 500000);
  assert.equal(inputTokenLimit({ ctx: 200000, max_output_tokens: 32000 }, {}).limit, 164000);
});

test("上下文预检：超限与放行", () => {
  const model = { ctx: 10000, max_output_tokens: 1000 };
  const small = { messages: [{ role: "user", content: "hi" }] };
  assert.equal(checkContext(small, model, {}), null);
  const overflow = checkContext({ messages: [{ role: "user", content: "x".repeat(40000) }] }, model, {});
  assert.ok(overflow);
  assert.equal(overflow.estimate, 10008);
  assert.equal(overflow.limit, 7976);
  assert.match(overflow.message, /输入过长/);
});

test("错误分类：限流/上下文/超时/鉴权", () => {
  assert.equal(classifyError({ status: 429, code: "rate_limit", message: "slow down" }).status, 429);
  assert.equal(classifyError({ status: 400, message: "maximum context length exceeded" }).code, "context_length_exceeded");
  assert.equal(classifyError({ status: 400, message: "输入过长：约 100 tokens" }).code, "context_length_exceeded");
  assert.equal(classifyError({ name: "TimeoutError", message: "The operation was aborted" }).status, 504);
  assert.equal(classifyError({ code: "upstream_auth", message: "401" }).status, 503);
  assert.equal(classifyError({ code: "upstream_error", status: 502, message: "bad gateway" }).status, 502);
  assert.equal(classifyError(new Error("boom")).status, 500);
});

test("错误协议映射：Anthropic 类型", () => {
  assert.equal(errorPayload({ status: 401 }, "anthropic").type, "authentication_error");
  assert.equal(errorPayload({ status: 429 }, "anthropic").type, "rate_limit_error");
  assert.equal(errorPayload({ status: 404 }, "anthropic").type, "not_found_error");
  assert.equal(errorPayload({ status: 429, code: "insufficient_quota" }, "openai").type, "insufficient_quota");
});

test("解析上游错误体", () => {
  const ctx = parseUpstreamError(400, JSON.stringify({ error: { message: "context length exceeded", type: "invalid_request_error" } }));
  assert.equal(ctx.status, 400);
  assert.equal(ctx.code, "context_length_exceeded");

  const auth = parseUpstreamError(403, "forbidden");
  assert.equal(auth.status, 502);
  assert.equal(auth.code, "upstream_auth");

  const rate = parseUpstreamError(429, '{"message":"too many requests"}');
  assert.equal(rate.status, 429);
  assert.equal(rate.code, "rate_limit_exceeded");

  const plain = parseUpstreamError(500, "boom");
  assert.equal(plain.status, 502);
  assert.equal(plain.code, "upstream_error");
});

test("Request ID：透传合法值，非法值重新生成", () => {
  const ok = new Request("https://gw.local/v1/models", { headers: { "x-request-id": "trace-abc_123" } });
  assert.equal(requestIdFor(ok), "trace-abc_123");
  const bad = new Request("https://gw.local/v1/models", { headers: { "x-request-id": "a b" } });
  assert.match(requestIdFor(bad), /^[0-9a-f-]{36}$/);
});
// ── 上游业务限制（藏在 SSE 首帧的 403 里）：不能当鉴权失败 ─────────────────
test("业务限制识别：110 今日额度用尽 → 429，不是鉴权", () => {
  const biz = businessLimitOf({
    code: 403,
    type: "upstream_error",
    message: '{"code":"110","message":"Billing daily count exceeded"}',
  });
  assert.equal(biz.status, 429);
  assert.equal(biz.code, "upstream_daily_quota");
  assert.match(biz.message, /请求次数已用尽/);
});

test("业务限制识别：10605 isQueued → 429 并带 retryAfterSeconds", () => {
  const biz = businessLimitOf({
    code: 403,
    type: "upstream_error",
    message:
      '{"code":"10605","message":"{\\"isQueued\\":true,\\"modelKey\\":\\"qfmodel\\",\\"queueCount\\":0,\\"queueType\\":\\"p3\\",\\"retryAfterSeconds\\":31}"}',
  });
  assert.equal(biz.status, 429);
  assert.equal(biz.code, "upstream_queued");
  assert.equal(biz.retryAfter, 31);
  assert.match(biz.message, /排队/);
});

test("业务限制识别：112 pricingUrl 额度用尽 → 429，不是鉴权", () => {
  const biz = businessLimitOf({
    code: 403,
    type: "upstream_error",
    message: '{"code":"112","message":"{\\"pricingUrl\\":\\"https://qoder.com/pricing?client=qoder\\"}"}',
  });
  assert.equal(biz.status, 429);
  assert.equal(biz.code, "upstream_quota_exhausted");
  assert.match(biz.message, /额度已用尽/);
});

test("业务限制识别：真鉴权文案不误判，未知 403 也不误判", () => {
  assert.equal(businessLimitOf({ code: 403, message: "invalid device token" }), null);
  assert.equal(businessLimitOf({ code: 401, message: "TOKEN_INVALID" }), null);
  assert.equal(businessLimitOf(null), null);
});

// ── 每日签到（国内版方式：账号池身份 + 只领列表 CLAIM_BENEFIT/CLAIMABLE）───
const MOCK_OPENAPI = "https://up.test";
const campaignsUrl = () => `${MOCK_OPENAPI}${CAMPAIGNS_PATH}`;
const claimUrl = (cid) => `${MOCK_OPENAPI}${CAMPAIGNS_PATH}/${cid}/claim`;
const usageUrl = () => `${MOCK_OPENAPI}${USAGE_PATH}`;

// 按 "GET/POST <url>" 路由 mock 上游；value 为 {status?, data} 或 (init) => 同结构。
// 返回 { calls, restore }；calls 记录每次请求便于断言（如"未发生 claim POST"）。
function mockOpenApi(routes) {
  const origFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const method = init.method || "GET";
    const key = `${method} ${String(url)}`;
    calls.push({ method, url: String(url), init });
    const hit = routes[key];
    if (!hit) {
      return new Response(JSON.stringify({ message: `unmocked ${key}` }), { status: 404 });
    }
    const { status = 200, data = {} } = (typeof hit === "function" ? hit(init) : hit) || {};
    return new Response(JSON.stringify(data), {
      status,
      headers: { "content-type": "application/json" },
    });
  };
  return { calls, restore: () => (globalThis.fetch = origFetch) };
}

function testAccount(overrides = {}) {
  return {
    id: "a1",
    uid: "u1",
    token: "dt-1",
    machine_id: "mid-1",
    machine_token: "",
    ...overrides,
  };
}

// CLAIM_BENEFIT 条目（国内版不区分当日与奖励类型，campaignKey 任意）。
function claimEntry({ claimStatus = "CLAIMABLE", id = "cid-1", key = "act-x-1", amount = 100 } = {}) {
  return {
    id,
    campaignKey: key,
    actionType: "CLAIM_BENEFIT",
    claimStatus,
    benefit: { kind: "CREDITS", amount },
  };
}

test("签到目标筛选：只挑 CLAIM_BENEFIT+CLAIMABLE 且有 id 的条目", () => {
  const cps = [
    claimEntry(),
    claimEntry({ claimStatus: "CLAIMED", id: "cid-claimed" }), // 已领过不重复 POST
    { id: "p1", campaignKey: "promo-x", actionType: "VIEW_DETAILS", claimStatus: "CLAIMABLE", benefit: null }, // 推广位
    { campaignKey: "no-id", actionType: "CLAIM_BENEFIT", claimStatus: "CLAIMABLE" }, // 无 campaignId
    { id: "p2", campaignKey: "y", actionType: "CLAIM_BENEFIT" }, // 无 claimStatus
  ];
  assert.deepEqual(claimableCampaigns(cps).map((c) => c.id), ["cid-1"]);
  assert.deepEqual(claimableCampaigns([]), []);
  assert.deepEqual(claimableCampaigns(null), []);
});

test("签到回执解读：CLAIMED/GRANTED 均算发放，区分本轮新领与此前已领", () => {
  assert.deepEqual(
    interpretClaim({ status: 200, claimStatus: "CLAIMED", replayed: false, grantedAt: "t" }),
    { secured: true, ok: true, message: "今日 100 Credits 本轮已领取" }
  );
  assert.deepEqual(
    interpretClaim({ status: 200, claimStatus: "CLAIMED", replayed: true, claimedAt: "t" }),
    { secured: true, ok: true, message: "今日 100 Credits 已到账（此前已领）" }
  );
  // replayed:false 但没有 grantedAt：无法证明本轮新领，按此前已领口径处理
  assert.deepEqual(interpretClaim({ status: 200, claimStatus: "CLAIMED", replayed: false }), {
    secured: true,
    ok: true,
    message: "今日 100 Credits 已到账（此前已领）",
  });
  // 旧协议 GRANTED 兼容：也算成功发放
  assert.deepEqual(interpretClaim({ status: 200, claimStatus: "GRANTED", replayed: false }), {
    secured: true,
    ok: true,
    message: "今日 100 Credits 本轮已领取",
  });
});

test("签到回执解读：BLOCKED+SAME_PERSON 属上游拒发（未到账但不算失败）", () => {
  const v = interpretClaim({
    status: 200,
    claimStatus: "BLOCKED",
    replayed: true,
    failureCode: "SAME_PERSON_ALREADY_CLAIMED",
    grantId: "g-1",
    benefit: { kind: "CREDITS", amount: 100 },
  });
  assert.equal(v.ok, true);
  assert.equal(v.secured, false);
  assert.match(v.message, /SAME_PERSON_ALREADY_CLAIMED/);
  assert.match(v.message, /拒发/);
});

test("签到回执解读：其它 BLOCKED 与 HTTP 非 200 判失败", () => {
  const other = interpretClaim({
    status: 200,
    claimStatus: "BLOCKED",
    failureCode: "OTHER",
    message: "nope",
  });
  assert.equal(other.ok, false);
  assert.equal(other.secured, false);
  assert.equal(other.error, "nope");
  assert.deepEqual(interpretClaim({ status: 500 }), {
    secured: false,
    ok: false,
    error: "claim HTTP 500",
  });
});

// ── 签到请求头：账号池身份（国内版 _cosy_device_headers 语义）──────────────
test("签到：campaigns GET 与 claim POST 均用账号池身份（token 空时 machine_id 顶替）", async () => {
  const account = testAccount(); // machine_id=mid-1, machine_token=""
  const mock = mockOpenApi({
    [`GET ${campaignsUrl()}`]: { data: { campaigns: [claimEntry()], claimable: true } },
    [`POST ${claimUrl("cid-1")}`]: {
      data: { status: "CLAIMED", replayed: false, grantedAt: "t", benefit: { kind: "CREDITS", amount: 100 } },
    },
    [`GET ${usageUrl()}`]: { data: { qoderUsage: { addOnQuota: { total: 100 } } } },
  });
  try {
    const { ok, rep } = await checkinAccount({ QODER_OPENAPI: MOCK_OPENAPI }, account);
    assert.equal(ok, true);
    assert.equal(rep.secured, true);
    const posts = mock.calls.filter((c) => c.method === "POST");
    const gets = mock.calls.filter((c) => c.method === "GET" && c.url === campaignsUrl());
    assert.equal(posts.length, 1, "应发生一次 claim POST");
    assert.ok(gets.length >= 2, "领前/领后各 GET 一次列表");
    for (const c of [...posts, ...gets]) {
      assert.equal(c.init.headers["Cosy-MachineId"], "mid-1"); // 账号池 machine_id
      assert.equal(c.init.headers["Cosy-MachineToken"], "mid-1"); // token 空时顶替
      assert.equal(c.init.headers["Cosy-ClientType"], "10"); // 桌面端身份
      assert.equal(c.init.headers["Cosy-Version"], "0.4.8"); // 桌面 App 版本（逆向规格）
      assert.equal(c.init.headers["Cosy-MachineHostname"], "DESKTOP-MID1"); // machine_id 确定性生成
    }
  } finally {
    mock.restore();
  }
});

test("签到：账号带独立 machine_token 时请求头用独立 token", async () => {
  const account = testAccount({ machine_token: "mtok-1" });
  const mock = mockOpenApi({
    [`GET ${campaignsUrl()}`]: { data: { campaigns: [claimEntry()], claimable: true } },
    [`POST ${claimUrl("cid-1")}`]: {
      data: { status: "CLAIMED", replayed: false, grantedAt: "t", benefit: { kind: "CREDITS", amount: 100 } },
    },
    [`GET ${usageUrl()}`]: { data: { qoderUsage: { addOnQuota: { total: 100 } } } },
  });
  try {
    await checkinAccount({ QODER_OPENAPI: MOCK_OPENAPI }, account);
    for (const c of mock.calls) {
      assert.equal(c.init.headers["Cosy-MachineId"], "mid-1");
      assert.equal(c.init.headers["Cosy-MachineToken"], "mtok-1"); // 有独立 token 用独立 token
    }
  } finally {
    mock.restore();
  }
});

// ── 签到请求形态（对齐 Qoder 桌面客户端 App 0.4.8 逆向规格 reverse_asar_findings.md）──
test("设备头：Cosy-Version 默认桌面 App 版本 0.4.8，账号 cosy_version 优先", () => {
  assert.equal(deviceHeaders({ machine_id: "mid-1" })["Cosy-Version"], "0.4.8");
  assert.equal(deviceHeaders({ machine_id: "mid-1", cosy_version: "0.4.9" })["Cosy-Version"], "0.4.9");
});

test("设备头：MachineHostname 账号字段优先，缺省由 machine_id 确定性生成", () => {
  const uuid = "02ab95d6-1234-4a5b-9c6d-0e1f2a3b4c5d";
  assert.equal(
    deviceHeaders({ machine_id: uuid, machine_hostname: "DESKTOP-REALHOST" })["Cosy-MachineHostname"],
    "DESKTOP-REALHOST"
  );
  assert.equal(deviceHeaders({ machine_id: uuid })["Cosy-MachineHostname"], "DESKTOP-02AB95D6");
  // 字段为纯空白视同缺省：走确定性生成
  assert.equal(
    deviceHeaders({ machine_id: uuid, machine_hostname: "   " })["Cosy-MachineHostname"],
    "DESKTOP-02AB95D6"
  );
  // machine_hostname 与 machine_id 皆缺 → 头丢弃（不发空值，等价桌面端 hostname 为空不发头）
  assert.ok(!("Cosy-MachineHostname" in deviceHeaders({})));
});

test("设备头：NYe 校验——非法值整头丢弃，合法值 trim 后发送", () => {
  const h = deviceHeaders({
    machine_id: " mid-1 ",
    machine_hostname: "  DESKTOP-X  ",
    machine_code: "中文设备码", // 非 ASCII
    machine_token: "",
  });
  assert.equal(h["Cosy-MachineId"], "mid-1"); // trim 后发送
  assert.equal(h["Cosy-MachineHostname"], "DESKTOP-X"); // trim 后发送
  assert.equal(h["Cosy-MachineToken"], "mid-1"); // token 空 → machine_id 顶替（trim 后）
  assert.ok(!("Cosy-MachineCode" in h), "含非 ASCII 的头整头丢弃");
  // 值中间含换行等不可打印字符同样丢弃；纯空白视同空值丢弃
  assert.ok(!("Cosy-MachineCode" in deviceHeaders({ machine_id: "mid-1", machine_code: "bad\nvalue" })));
  assert.ok(!("Cosy-MachineCode" in deviceHeaders({ machine_id: "mid-1", machine_code: "\t" })));
});

test("签到请求形态：campaigns/usage GET 用 UA=Qoder，claim POST 用 Electron UA", async () => {
  const mock = mockOpenApi({
    [`GET ${campaignsUrl()}`]: { data: { campaigns: [claimEntry()], claimable: true } },
    [`POST ${claimUrl("cid-1")}`]: {
      data: { status: "CLAIMED", replayed: false, grantedAt: "t", benefit: { kind: "CREDITS", amount: 100 } },
    },
    [`GET ${usageUrl()}`]: { data: { qoderUsage: { addOnQuota: { total: 100 } } } },
  });
  try {
    const { ok } = await checkinAccount({ QODER_OPENAPI: MOCK_OPENAPI }, testAccount());
    assert.equal(ok, true);
    const campaignGets = mock.calls.filter((c) => c.method === "GET" && c.url === campaignsUrl());
    const usageGets = mock.calls.filter((c) => c.method === "GET" && c.url === usageUrl());
    const posts = mock.calls.filter((c) => c.method === "POST");
    assert.ok(campaignGets.length >= 2, "领前/领后各 GET 一次列表");
    assert.equal(usageGets.length, 1, "有领过才读额度桶");
    // 列表 GET（nativeHttpService）UA 字面量 "Qoder"；usage 同为主进程 native 请求
    for (const c of [...campaignGets, ...usageGets]) {
      assert.equal(c.init.headers["User-Agent"], "Qoder");
    }
    // claim 由 H5 iframe 发出，走 Electron session 默认 UA（qoder/ 版本随 App 版本）
    for (const c of posts) {
      assert.equal(
        c.init.headers["User-Agent"],
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) qoder/0.4.8 Chrome/143.0.0.0 Electron/43.1.1 Safari/537.36"
      );
    }
  } finally {
    mock.restore();
  }
});

test("对话/续期链路不动：accountAuth 的 cosyVersion 默认仍为 CLI 版本 1.1.69", () => {
  assert.equal(accountAuth({}).cosyVersion, "1.1.69");
  assert.equal(accountAuth({ cosy_version: "0.4.9" }).cosyVersion, "0.4.9");
});

test("签到：多个 CLAIMABLE 条目逐个都领（2 条目 → 2 次 POST claim）", async () => {
  const t1 = claimEntry({ id: "cid-1", key: "act-a-1" });
  const t2 = claimEntry({ id: "cid-2", key: "act-b-2", amount: 50 });
  const mock = mockOpenApi({
    [`GET ${campaignsUrl()}`]: { data: { campaigns: [t1, t2], claimable: true } },
    [`POST ${claimUrl("cid-1")}`]: {
      data: { status: "CLAIMED", replayed: false, grantedAt: "t1", benefit: { kind: "CREDITS", amount: 100 } },
    },
    [`POST ${claimUrl("cid-2")}`]: {
      data: { status: "CLAIMED", replayed: false, grantedAt: "t2", benefit: { kind: "CREDITS", amount: 50 } },
    },
    [`GET ${usageUrl()}`]: { data: { qoderUsage: { addOnQuota: { total: 150 } } } },
  });
  try {
    const { ok, rep } = await checkinAccount({ QODER_OPENAPI: MOCK_OPENAPI }, testAccount());
    assert.equal(ok, true);
    assert.equal(rep.secured, true);
    assert.equal(rep.claimed.length, 2);
    assert.deepEqual(rep.claimed.map((c) => c.id), ["cid-1", "cid-2"]);
    assert.equal(rep.claimed[1].amount, 50);
    assert.equal(rep.addOnTotal, 150); // 有领过才读额度桶
    assert.deepEqual(
      mock.calls.filter((c) => c.method === "POST").map((c) => c.url),
      [claimUrl("cid-1"), claimUrl("cid-2")]
    );
  } finally {
    mock.restore();
  }
});

test("签到：列表已 CLAIMED → 成功 no-op（不发 POST）", async () => {
  const mock = mockOpenApi({
    [`GET ${campaignsUrl()}`]: { data: { campaigns: [claimEntry({ claimStatus: "CLAIMED" })], claimable: false } },
  });
  try {
    const { ok, rep } = await checkinAccount({ QODER_OPENAPI: MOCK_OPENAPI }, testAccount());
    assert.equal(ok, true);
    assert.equal(rep.secured, true);
    assert.equal(rep.message, "今天的 Credits 已在手上（之前领过）");
    assert.equal(rep.claimed.length, 0);
    assert.equal(rep.addOnTotal, undefined); // no-op 不读额度桶（对齐国内版）
    assert.ok(mock.calls.every((c) => c.method === "GET"), "不应发生 claim POST");
  } finally {
    mock.restore();
  }
});

test("签到：无 CLAIMABLE 条目（空列表）→ 成功 no-op", async () => {
  const mock = mockOpenApi({
    [`GET ${campaignsUrl()}`]: { data: { campaigns: [], claimable: false } },
  });
  try {
    const { ok, rep } = await checkinAccount({ QODER_OPENAPI: MOCK_OPENAPI }, testAccount());
    assert.equal(ok, true);
    assert.equal(rep.secured, false);
    assert.equal(rep.message, "当前没有可领取的活动（未到窗口或活动已结束）");
    assert.equal(rep.claimed.length, 0);
    assert.ok(mock.calls.every((c) => c.method === "GET"), "不应发生 claim POST");
  } finally {
    mock.restore();
  }
});

test("签到：VIEW_DETAILS 条目不会被 POST", async () => {
  const promo = { id: "p1", campaignKey: "promo-x", actionType: "VIEW_DETAILS", claimStatus: "CLAIMABLE", benefit: null };
  const mock = mockOpenApi({
    [`GET ${campaignsUrl()}`]: { data: { campaigns: [promo], claimable: true } },
  });
  try {
    const { ok, rep } = await checkinAccount({ QODER_OPENAPI: MOCK_OPENAPI }, testAccount());
    assert.equal(ok, true);
    assert.equal(rep.secured, false);
    assert.equal(rep.message, "当前没有可领取的活动（未到窗口或活动已结束）");
    assert.equal(rep.claimed.length, 0);
    assert.ok(mock.calls.every((c) => c.method === "GET"), "不应发生 claim POST");
    assert.ok(!mock.calls.some((c) => c.url === claimUrl("p1")), "推广位不得被 POST");
  } finally {
    mock.restore();
  }
});

test("签到：claim HTTP 500 判失败并带上游 message", async () => {
  const mock = mockOpenApi({
    [`GET ${campaignsUrl()}`]: { data: { campaigns: [claimEntry()], claimable: true } },
    [`POST ${claimUrl("cid-1")}`]: { status: 500, data: { message: "upstream boom" } },
    [`GET ${usageUrl()}`]: { data: { qoderUsage: { addOnQuota: { total: 0 } } } },
  });
  try {
    const { ok, rep } = await checkinAccount({ QODER_OPENAPI: MOCK_OPENAPI }, testAccount());
    assert.equal(ok, false);
    assert.equal(rep.error, "upstream boom");
    assert.equal(rep.message, "upstream boom");
  } finally {
    mock.restore();
  }
});

test("签到：SAME_PERSON 回执 HTTP 200 也算 ok（未到账但不报错）", async () => {
  const mock = mockOpenApi({
    [`GET ${campaignsUrl()}`]: { data: { campaigns: [claimEntry()], claimable: true } },
    [`POST ${claimUrl("cid-1")}`]: {
      data: {
        status: "BLOCKED",
        replayed: true,
        failureCode: "SAME_PERSON_ALREADY_CLAIMED",
        claimedAt: "2026-10-20T03:31:00Z",
        grantId: "g-x",
        benefit: { kind: "CREDITS", amount: 100 },
      },
    },
    [`GET ${usageUrl()}`]: { data: { qoderUsage: { addOnQuota: { total: 0 } } } },
  });
  try {
    const { ok, rep } = await checkinAccount({ QODER_OPENAPI: MOCK_OPENAPI }, testAccount());
    assert.equal(ok, true);
    assert.equal(rep.secured, false);
    assert.equal(rep.error, undefined);
    assert.match(rep.message, /SAME_PERSON_ALREADY_CLAIMED/);
    assert.equal(rep.claimed[0].failureCode, "SAME_PERSON_ALREADY_CLAIMED");
  } finally {
    mock.restore();
  }
});

// ── PATCH /api/accounts/:id：线上同步账号独立设备身份 ───────────────────────
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

test("PATCH /api/accounts/:id：更新 machine_id 等设备身份字段，白名单外字段忽略", async () => {
  const env = { KV: memoryKV(), ADMIN_PASSWORD: "pw" };
  await importAccounts(env, { accounts: [{ token: "dt-1", uid: "u1", machineId: "mid-old" }] });
  const row = (await listAccounts(env))[0];
  const resp = await worker.fetch(
    new Request(`https://gw.local/api/accounts/${row.id}`, {
      method: "PATCH",
      headers: { Authorization: "Bearer pw", "Content-Type": "application/json" },
      body: JSON.stringify({ machine_id: "mid-new", machine_token: "mtok-new", nope: "x", id: "hack" }),
    }),
    env,
    { waitUntil: () => {} }
  );
  assert.equal(resp.status, 200);
  const body = await resp.json();
  assert.equal(body.id, row.id); // 白名单外字段（id）改不动
  assert.equal(body.machine_id, "mid-new");
  const saved = await getAccount(env, row.id);
  assert.equal(saved.machine_id, "mid-new");
  assert.equal(saved.machine_token, "mtok-new");
  assert.equal(saved.nope, undefined); // 非白名单字段不落库
  assert.equal(saved.token, "dt-1"); // 同步身份不动 token
});

test("PATCH /api/accounts/:id：machine_hostname 与 cosy_version 可同步（签到形态字段）", async () => {
  const env = { KV: memoryKV(), ADMIN_PASSWORD: "pw" };
  await importAccounts(env, { accounts: [{ token: "dt-1", uid: "u1", machineId: "mid-old" }] });
  const row = (await listAccounts(env))[0];
  const resp = await worker.fetch(
    new Request(`https://gw.local/api/accounts/${row.id}`, {
      method: "PATCH",
      headers: { Authorization: "Bearer pw", "Content-Type": "application/json" },
      body: JSON.stringify({ machine_hostname: "DESKTOP-REALHOST", cosy_version: "0.4.9" }),
    }),
    env,
    { waitUntil: () => {} }
  );
  assert.equal(resp.status, 200);
  const body = await resp.json();
  assert.equal(body.machine_hostname, "DESKTOP-REALHOST"); // 响应可见（publicAccount 暴露）
  const saved = await getAccount(env, row.id);
  assert.equal(saved.machine_hostname, "DESKTOP-REALHOST"); // 白名单落库
  assert.equal(saved.cosy_version, "0.4.9");
  // 同步后签到设备头直接用上
  assert.equal(deviceHeaders(saved)["Cosy-MachineHostname"], "DESKTOP-REALHOST");
  assert.equal(deviceHeaders(saved)["Cosy-Version"], "0.4.9");
});

test("PATCH /api/accounts/:id：账号不存在返回 404", async () => {
  const env = { KV: memoryKV(), ADMIN_PASSWORD: "pw" };
  const resp = await worker.fetch(
    new Request("https://gw.local/api/accounts/nope", {
      method: "PATCH",
      headers: { Authorization: "Bearer pw", "Content-Type": "application/json" },
      body: JSON.stringify({ machine_id: "mid-new" }),
    }),
    env,
    { waitUntil: () => {} }
  );
  assert.equal(resp.status, 404);
  const body = await resp.json();
  assert.equal(body.error.message, "账号不存在");
});
