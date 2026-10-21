// 上游回合：换号、签名、首帧探错、OpenAI SSE 输出。
import {
  FrameReader,
  aggregateFrames,
  errorOf,
  signedFetchInfer,
} from "./qoder/client.js";
import { candidateAccounts, ensureFresh, markFailed } from "./accounts.js";
import { classifyError, parseUpstreamError, businessLimitOf } from "./errors.js";

export class UpstreamError extends Error {
  constructor(message, status = 502, code = "upstream_error") {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function authish(code) {
  return code === 401 || code === 403;
}

/**
 * 打开一个上游回合。返回 {reader, firstFrame, account}；
 * 首帧已确认不是鉴权错误（其他错误首帧直接抛 UpstreamError）。
 */
export async function startChat(env, openaiBody, model) {
  const tried = new Set();
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const candidates = await candidateAccounts(env, tried);
    if (!candidates.length) break;
    const account = candidates[0];
    tried.add(account.id);
    let fresh;
    try {
      fresh = await ensureFresh(env, account);
    } catch (e) {
      lastError = e;
      continue;
    }
    if (!fresh.token || (fresh.refresh_dead && (!fresh.exp || fresh.exp <= Date.now() / 1000))) {
      lastError = new UpstreamError(`账号 ${fresh.label} 续期链已失效`, 503, "no_account");
      continue;
    }
    let resp;
    try {
      resp = await signedFetchInfer(fresh, openaiBody, model, env.QODER_GATEWAY);
    } catch (e) {
      const timeout = e?.name === "TimeoutError" || /timed? ?out|timeout/i.test(String(e?.message || ""));
      lastError = new UpstreamError(
        timeout ? `上游请求超时: ${e?.message || e}` : `上游连接失败: ${e?.message || e}`,
        timeout ? 504 : 503,
        timeout ? "upstream_timeout" : "upstream_unavailable"
      );
      continue;
    }
    if (authish(resp.status)) {
      console.warn(`换号#${attempt} uid=${String(fresh.uid || "").slice(0, 8)} 传输层 HTTP ${resp.status}`);
      await markFailed(env, fresh, resp.status);
      await resp.body?.cancel().catch(() => {});
      lastError = new UpstreamError(`上游鉴权失败 ${resp.status}，已切换账号`, 502, "upstream_auth");
      continue;
    }
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      const info = parseUpstreamError(resp.status, text || resp.statusText);
      lastError = new UpstreamError(info.message, info.status, info.code);
      if (resp.status === 429 || resp.status >= 500) continue;
      throw lastError;
    }

    const reader = new FrameReader(resp.body);
    let firstFrame = null;
    let retry = false;
    while (true) {
      const item = await reader.next();
      if (item.done) break;
      firstFrame = item.value;
      let obj = null;
      try {
        obj = JSON.parse(firstFrame);
      } catch {
        // 非 JSON 帧交给后续流程丢弃
      }
      const err = errorOf(obj);
      if (err) {
        const code = Number(err.code) || 0;
        // 上游把业务限制写成 statusCodeValue 403 的首帧（今日额度用尽 / 模型排队），
        // 先认这类，否则会被当成鉴权失败：拉黑 healthy 账号、对客报 503。
        const biz = businessLimitOf(err);
        if (biz) {
          lastError = new UpstreamError(biz.message, biz.status, biz.code);
          retry = true;
          break;
        }
        if (authish(code)) {
          console.warn(
            `换号#${attempt} uid=${String(fresh.uid || "").slice(0, 8)} 首帧 code=${code} ` +
              `text=${String(err.message || "").slice(0, 240)}`
          );
          await markFailed(env, fresh, code);
          retry = true;
          lastError = new UpstreamError(`上游鉴权失败 ${code}，已切换账号`, 502, "upstream_auth");
          break;
        }
        const info = parseUpstreamError(code || 502, JSON.stringify(err));
        // 首帧尚未向客户端输出内容，限流/上游 5xx 可以安全换号
        if (code === 429 || code >= 500) {
          lastError = new UpstreamError(info.message, info.status, info.code);
          retry = true;
          break;
        }
        throw new UpstreamError(info.message, info.status, info.code);
      }
      break;
    }
    if (retry) {
      await reader.close();
      continue;
    }
    return { reader, firstFrame, account: fresh };
  }
  throw lastError || new UpstreamError("账号池为空或全部不可用", 503, "no_account");
}

export async function collectChat(env, openaiBody, model, maxFrames = 20000) {
  const { reader, firstFrame, account } = await startChat(env, openaiBody, model);
  const frames = [];
  if (firstFrame) frames.push(firstFrame);
  try {
    while (frames.length < maxFrames) {
      const item = await reader.next();
      if (item.done) break;
      frames.push(item.value);
    }
  } finally {
    await reader.close();
  }
  const merged = aggregateFrames(frames, model.key);
  if (merged.error) {
    const err = errorOf(merged.error) || {};
    const info = parseUpstreamError(Number(err.code) || 502, JSON.stringify(err));
    throw new UpstreamError(info.message, info.status, info.code);
  }
  return { merged, account };
}

// 把解包后的上游帧转成标准 OpenAI SSE。返回 {stream, done:Promise<usage>}。
export function openaiSseStream(reader, firstFrame, modelName) {
  const encoder = new TextEncoder();
  let pending = firstFrame || null;
  let usage = null;
  let resolveDone;
  const done = new Promise((resolve) => {
    resolveDone = resolve;
  });

  const stream = new ReadableStream({
    async pull(controller) {
      try {
        while (true) {
          let item;
          if (pending !== null) {
            item = { done: false, value: pending };
            pending = null;
          } else {
            item = await reader.next();
          }
          if (item.done) {
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
            resolveDone(usage);
            return;
          }
          let obj;
          try {
            obj = JSON.parse(item.value);
          } catch {
            continue;
          }
          const err = errorOf(obj);
          if (err) {
            const info = classifyError({ message: err.message || "上游返回错误", code: err.code });
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({
                  error: { message: info.message, type: info.type, code: info.code },
                })}\n\n`
              )
            );
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
            resolveDone(usage);
            return;
          }
          if (obj.usage) usage = obj.usage;
          if (obj.object === undefined) obj.object = "chat.completion.chunk";
          if (obj.model === undefined) obj.model = modelName;
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
          return;
        }
      } catch (e) {
        controller.error(e);
        resolveDone(usage);
      }
    },
    cancel() {
      reader.close();
      resolveDone(usage);
    },
  });

  return { stream, done };
}
