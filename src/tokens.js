// 轻量 token 估算：CJK 按 0.6、其他字符按 4 字符/token，用于上游调用前的上下文预检。
function isCjk(cp) {
  return (
    (cp >= 0x2e80 && cp <= 0x9fff) ||
    (cp >= 0xac00 && cp <= 0xd7af) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xff00 && cp <= 0xffef)
  );
}

export function estimateTextTokens(value) {
  if (value === null || value === undefined) return 0;
  const text = typeof value === "string" ? value : (() => {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  })();
  if (!text) return 0;
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    if (isCjk(ch.codePointAt(0))) cjk++;
    else other++;
  }
  return Math.ceil(cjk * 0.6 + other / 4);
}

function estimateContent(content) {
  if (content === null || content === undefined) return 0;
  if (typeof content === "string") return estimateTextTokens(content);
  if (!Array.isArray(content)) return estimateTextTokens(content);
  let total = 0;
  for (const part of content) {
    if (part === null || part === undefined) continue;
    if (typeof part === "string") {
      total += estimateTextTokens(part);
      continue;
    }
    switch (part.type) {
      case "text":
      case "input_text":
      case "output_text":
        total += estimateTextTokens(part.text || "");
        break;
      case "image":
      case "image_url":
      case "input_image":
        total += 1000;
        break;
      case "thinking":
        total += estimateTextTokens(part.thinking || "");
        break;
      case "tool_result":
        total += estimateContent(part.content);
        break;
      case "tool_use":
        total += estimateTextTokens(part.input || "");
        break;
      default:
        total += estimateTextTokens(part.text || part.content || part);
        break;
    }
  }
  return total;
}

export function estimateChatTokens(body) {
  let total = 3;
  if (body?.system) total += estimateContent(body.system);
  if (Array.isArray(body?.messages)) {
    for (const msg of body.messages) {
      if (!msg) continue;
      total += 4;
      total += estimateTextTokens(msg.role || "");
      total += estimateContent(msg.content);
      if (msg.reasoning_content) total += estimateTextTokens(msg.reasoning_content);
      if (Array.isArray(msg.tool_calls)) {
        for (const call of msg.tool_calls) {
          total += estimateTextTokens(call?.function?.name || "");
          total += estimateTextTokens(call?.function?.arguments || "");
        }
      }
    }
  }
  if (body?.tools) total += estimateTextTokens(body.tools);
  if (body?.functions) total += estimateTextTokens(body.functions);
  if (body?.tool_choice) total += estimateTextTokens(body.tool_choice);
  if (body?.response_format) total += estimateTextTokens(body.response_format);
  return total;
}

export function inputTokenLimit(model, env) {
  const ctx = Number(model?.ctx) || 200000;
  const modelMaxOut = Number(model?.max_output_tokens) || 32000;
  const requested = Number(env?.MAX_INPUT_TOKENS) || 0;
  const margin = Math.max(1024, Math.ceil(ctx * 0.02));
  let limit = Math.max(1024, ctx - modelMaxOut - margin);
  if (requested > 0) limit = Math.min(limit, requested);
  return { ctx, maxOut: modelMaxOut, margin, limit };
}

export function checkContext(body, model, env) {
  const estimate = estimateChatTokens(body);
  const { ctx, maxOut, margin, limit } = inputTokenLimit(model, env);
  if (estimate <= limit) return null;
  return {
    estimate,
    ctx,
    maxOut,
    margin,
    limit,
    message:
      `输入过长：约 ${estimate} tokens，超过当前上限 ${limit}` +
      `（模型上下文 ${ctx} - 最大输出 ${maxOut} - 安全余量 ${margin}）。` +
      `请缩短输入或换用更大上下文的模型。`,
  };
}
