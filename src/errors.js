// 错误归一化：把上游/内部错误映射成稳定的 HTTP 状态、错误码与协议类型。
const CONTEXT_RE =
  /context (?:length|window)|maximum context|(?:too many|max(?:imum)?) (?:input )?tokens|token (?:limit|count) (?:exceeded|too (?:large|long))|prompt is too long|input is too long|exceeds? (?:the )?(?:maximum|max)|上下文|输入.*过长|请求.*过大/i;

const RID_RE = /^[A-Za-z0-9._-]{1,80}$/;

export function requestIdFor(request) {
  const given = (request.headers.get("x-request-id") || "").trim();
  return RID_RE.test(given) ? given : crypto.randomUUID();
}

function textOf(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function asStatus(value) {
  const n = Number(value) || 0;
  return n >= 400 && n <= 599 ? n : 0;
}

export function classifyError(error) {
  const status = asStatus(error?.status);
  const code = String(error?.code || "").trim();
  const low = code.toLowerCase();
  const message = String(error?.message || error || "服务器内部错误");

  if (low === "context_length_exceeded" || CONTEXT_RE.test(message)) {
    return { status: 400, code: "context_length_exceeded", type: "invalid_request_error", message };
  }
  if (low === "quota_exceeded" || low === "insufficient_quota" || status === 402) {
    return { status: 429, code: "insufficient_quota", type: "insufficient_quota", message };
  }
  if (status === 429 || low === "rate_limit" || low === "rate_limit_exceeded") {
    return { status: 429, code: "rate_limit_exceeded", type: "rate_limit_error", message };
  }
  if (status === 401 || status === 403 || low === "expired_api_key" || low === "invalid_api_key") {
    return { status: 401, code: low || "invalid_api_key", type: "authentication_error", message };
  }
  if (low === "no_account") {
    return { status: 503, code: "no_account", type: "service_unavailable", message };
  }
  if (low === "upstream_auth") {
    return { status: 503, code: "upstream_auth", type: "service_unavailable", message };
  }
  if (low === "upstream_timeout" || error?.name === "TimeoutError" || /timed? ?out|timeout|abort/i.test(message)) {
    return { status: 504, code: "upstream_timeout", type: "api_error", message };
  }
  if (low === "upstream_unavailable" || /fetch failed|network|connection|econn|socket/i.test(message)) {
    return { status: 503, code: "upstream_unavailable", type: "service_unavailable", message };
  }
  if (status === 404 || low === "model_not_found") {
    return { status: 404, code: "model_not_found", type: "invalid_request_error", message };
  }
  if (status === 400 || status === 413 || status === 422 || low === "invalid_request_error") {
    return {
      status: status === 413 ? 413 : 400,
      code: low || "invalid_request_error",
      type: "invalid_request_error",
      message,
    };
  }
  if (status >= 500) {
    return {
      status: status === 503 ? 503 : status === 504 ? 504 : 502,
      code: code || "upstream_error",
      type: "api_error",
      message,
    };
  }
  if (status >= 400) {
    return { status, code: code || "invalid_request_error", type: "invalid_request_error", message };
  }
  return { status: 500, code: code || "server_error", type: "api_error", message };
}

export function errorPayload(error, protocol = "openai") {
  const out = classifyError(error);
  if (protocol === "anthropic") {
    if (out.status === 401) out.type = "authentication_error";
    else if (out.status === 429) out.type = "rate_limit_error";
    else if (out.status === 404) out.type = "not_found_error";
    else if (out.status >= 500) out.type = "api_error";
    else out.type = "invalid_request_error";
  } else if (out.status === 401) {
    out.type = "invalid_request_error";
  } else if (out.status === 429 && out.code === "insufficient_quota") {
    out.type = "insufficient_quota";
  }
  return out;
}

/**
 * 上游把业务限制写在 SSE 首帧里（HTTP 200 + statusCodeValue 403，内层还有一层 JSON
 * 字符串），code/message 都不是鉴权语义。实测三种：
 *   {"code":"110","message":"Billing daily count exceeded"}   → 该号当日请求次数用尽
 *   {"code":"403","message":"{\"code\":\"10605\",\"message\":\"{\\\"isQueued\\\":true...}"}
 *                                                             → 模型排队限流
 *   {"code":"112","message":"{\"pricingUrl\":\"...\"}"}        → 该号额度用尽
 * 命中就按 429 处理并换号；真鉴权失败仍走 authish 分支。
 */
export function businessLimitOf(err) {
  const text = `${err?.code ?? ""} ${err?.message ?? ""}`.toLowerCase();
  if (text.includes("billing daily count exceeded") || text.includes("daily count exceeded")) {
    return { status: 429, code: "upstream_daily_quota", retryAfter: 0,
      message: "该账号今日上游请求次数已用尽（Billing daily count exceeded）" };
  }
  if (text.includes("isqueued") || text.includes("10605")) {
    const wait = Number((text.match(/retryafter\w*[^0-9]{0,4}(\d+)/) || [])[1]) || 0;
    return { status: 429, code: "upstream_queued", retryAfter: wait,
      message: `上游模型排队中（isQueued）${wait ? `，建议 ${wait}s 后重试` : ""}` };
  }
  // 上游把「额度用尽」也写成首帧 403，内层 code=112 并附带计费页地址。
  if (text.includes('"code":"112"') || text.includes("pricingurl")) {
    return { status: 429, code: "upstream_quota_exhausted", retryAfter: 0,
      message: "该账号上游额度已用尽（Billing quota exhausted，上游 code=112）" };
  }
  return null;
}

export function parseUpstreamError(status, body) {
  const raw = textOf(body).slice(0, 4000);
  let obj = null;
  try {
    obj = JSON.parse(raw);
  } catch {
    obj = null;
  }

  let message = "";
  let code = "";
  if (obj && typeof obj === "object") {
    const err = obj.error;
    if (typeof err === "string") {
      message = err;
    } else if (err && typeof err === "object") {
      message = textOf(err.message || err.msg || err.detail || "");
      code = textOf(err.code || err.type || "");
    }
    if (!message) message = textOf(obj.message || obj.msg || obj.error_msg || obj.detail || "");
    if (!code) code = textOf(obj.error_code || obj.code || "");
    if (!message && err && typeof err === "object") message = textOf(err);
  }
  if (!message) {
    message = raw && raw !== "undefined" ? raw : `上游返回 HTTP ${status}`;
  }
  message = message.slice(0, 600);

  if (Number(status) === 401 || Number(status) === 403) {
    return {
      status: 502,
      code: "upstream_auth",
      type: "service_unavailable",
      message: `上游鉴权失败（${status}）：${message}`,
    };
  }
  return classifyError({ status, code, message });
}
