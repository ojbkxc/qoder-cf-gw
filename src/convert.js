// 协议转换：Anthropic Messages / OpenAI Responses ⇄ Chat Completions。
// 转换与 SSE 状态机借鉴 cf-ai-gw，但只保留与上游无关的部分。

export function convertAnthropicToOpenAI(body) {
  const out = {};
  out.model = body.model;
  if (body.max_tokens !== undefined) out.max_tokens = body.max_tokens;
  if (body.stream !== undefined) out.stream = body.stream;
  if (body.temperature !== undefined) out.temperature = body.temperature;
  if (body.top_p !== undefined) out.top_p = body.top_p;
  if (body.stop_sequences !== undefined) out.stop = body.stop_sequences;
  if (body.thinking?.type === "enabled") out.reasoning_effort = "high";
  if (body.metadata?.user_id) out.user = body.metadata.user_id;

  const messages = [];
  if (body.system) {
    let system = "";
    if (typeof body.system === "string") system = body.system;
    else if (Array.isArray(body.system)) {
      for (const block of body.system) {
        if (block.type === "text" && block.text) system += block.text + "\n";
      }
      system = system.trim();
    }
    if (system) messages.push({ role: "system", content: system });
  }

  for (const msg of body.messages || []) {
    const role = msg.role;
    const content = msg.content;
    if (typeof content === "string") {
      messages.push({ role, content });
      continue;
    }
    if (!Array.isArray(content)) continue;

    if (role === "assistant") {
      let text = "";
      const toolCalls = [];
      for (const block of content) {
        if (block.type === "text") text += block.text || "";
        else if (block.type === "tool_use") {
          toolCalls.push({
            id: block.id,
            type: "function",
            function: { name: block.name, arguments: JSON.stringify(block.input || {}) },
          });
        }
      }
      const m = { role: "assistant", content: text || null };
      if (toolCalls.length) m.tool_calls = toolCalls;
      messages.push(m);
      continue;
    }

    if (role === "user") {
      for (const block of content) {
        if (block.type !== "tool_result") continue;
        let result = "";
        if (typeof block.content === "string") result = block.content;
        else if (Array.isArray(block.content)) {
          for (const c of block.content) if (c.type === "text" && c.text) result += c.text;
        }
        const toolMsg = { role: "tool", tool_call_id: block.tool_use_id, content: result };
        if (block.name) toolMsg.name = block.name;
        messages.push(toolMsg);
      }
      const parts = [];
      for (const block of content) {
        if (block.type === "text") parts.push({ type: "text", text: block.text || "" });
        else if (block.type === "image") {
          const source = block.source || {};
          let url = "";
          if (source.type === "url" && source.url) url = source.url;
          else if (source.data) url = `data:${source.media_type || "image/png"};base64,${source.data}`;
          if (url) parts.push({ type: "image_url", image_url: { url } });
        }
      }
      if (parts.length) messages.push({ role: "user", content: parts });
      continue;
    }

    const parts = [];
    for (const block of content) {
      if (block.type === "text") parts.push({ type: "text", text: block.text || "" });
    }
    if (parts.length) messages.push({ role, content: parts });
  }

  const firstNonSystem = messages.find((m) => m.role !== "system");
  if (firstNonSystem && firstNonSystem.role === "assistant") {
    const systemCount = messages.filter((m) => m.role === "system").length;
    messages.splice(systemCount, 0, { role: "user", content: " " });
  }
  out.messages = messages;

  if (Array.isArray(body.tools)) {
    out.tools = body.tools.map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description || "",
        parameters: tool.input_schema || {},
      },
    }));
  }
  if (body.tool_choice) {
    const tc = body.tool_choice;
    const type = typeof tc === "string" ? tc : tc.type;
    if (type === "auto") out.tool_choice = "auto";
    else if (type === "any") out.tool_choice = "required";
    else if (type === "none") out.tool_choice = "none";
    else if (type === "tool" && tc.name) out.tool_choice = { type: "function", function: { name: tc.name } };
  }
  return out;
}

export function convertOpenAIToAnthropic(response, originalModel, stopSequences) {
  const choice = response.choices?.[0] || {};
  const message = choice.message || {};
  const out = {
    id: `msg_${crypto.randomUUID()}`,
    type: "message",
    role: "assistant",
    content: [],
    model: originalModel,
    stop_reason: null,
    stop_sequence: null,
    usage: {
      input_tokens: response.usage?.prompt_tokens || 0,
      output_tokens: response.usage?.completion_tokens || 0,
      cache_creation_input_tokens: response.usage?.cache_creation_input_tokens || 0,
      cache_read_input_tokens:
        response.usage?.prompt_tokens_details?.cached_tokens ??
        response.usage?.cache_read_input_tokens ??
        0,
    },
  };
  if (message.reasoning_content) {
    out.content.push({ type: "thinking", thinking: message.reasoning_content });
  }
  if (message.content) out.content.push({ type: "text", text: message.content });
  if (Array.isArray(message.tool_calls)) {
    for (const tc of message.tool_calls) {
      let input = {};
      try {
        input = typeof tc.function?.arguments === "string" ? JSON.parse(tc.function.arguments) : tc.function?.arguments || {};
      } catch {
        input = {};
      }
      out.content.push({ type: "tool_use", id: tc.id, name: tc.function?.name || "", input });
    }
  }
  const finish = choice.finish_reason;
  if (finish === "stop") {
    let hit = null;
    if (Array.isArray(stopSequences) && typeof message.content === "string") {
      for (const s of stopSequences) {
        if (s && message.content.endsWith(s)) {
          hit = s;
          break;
        }
      }
      if (hit === null && stopSequences.length === 1 && stopSequences[0]) hit = stopSequences[0];
    }
    if (hit !== null) {
      out.stop_reason = "stop_sequence";
      out.stop_sequence = hit;
    } else out.stop_reason = "end_turn";
  } else if (finish === "tool_calls") out.stop_reason = "tool_use";
  else if (finish === "length") out.stop_reason = "max_tokens";
  else out.stop_reason = finish || "end_turn";
  return out;
}

export function convertResponsesToOpenAI(body) {
  const out = {};
  if (body.max_output_tokens !== undefined) out.max_tokens = body.max_output_tokens;
  if (body.temperature !== undefined) out.temperature = body.temperature;
  if (body.top_p !== undefined) out.top_p = body.top_p;
  if (body.stop !== undefined) out.stop = body.stop;
  if (body.stream !== undefined) out.stream = body.stream;
  if (body.parallel_tool_calls !== undefined) out.parallel_tool_calls = body.parallel_tool_calls;
  if (body.reasoning?.effort) out.reasoning_effort = body.reasoning.effort;
  const textFormat = body.text?.format;
  if (textFormat?.type === "json_schema" && textFormat.schema) {
    const schema = { name: textFormat.name || "response", schema: textFormat.schema };
    if (textFormat.strict !== undefined) schema.strict = textFormat.strict;
    out.response_format = { type: "json_schema", json_schema: schema };
  }
  if (body.tool_choice !== undefined) {
    const tc = body.tool_choice;
    if (typeof tc === "string") out.tool_choice = tc;
    else if (tc?.type === "function" && tc.name) {
      out.tool_choice = { type: "function", function: { name: tc.name } };
    } else out.tool_choice = tc;
  }

  const messages = [];
  if (typeof body.instructions === "string" && body.instructions) {
    messages.push({ role: "system", content: body.instructions });
  }
  if (typeof body.input === "string") {
    messages.push({ role: "user", content: body.input });
  } else if (Array.isArray(body.input)) {
    for (const item of body.input) {
      if (!item || typeof item !== "object") continue;
      if (item.type === "message") {
        const role = item.role === "assistant" ? "assistant" : "user";
        let text = "";
        if (typeof item.content === "string") text = item.content;
        else if (Array.isArray(item.content)) {
          for (const part of item.content) {
            if (["input_text", "output_text", "text"].includes(part.type) && part.text) text += part.text;
            else if (part.type === "input_image") text += "[to be added]";
          }
        }
        messages.push({ role, content: text });
      } else if (item.type === "function_call") {
        const call = {
          id: item.call_id,
          type: "function",
          function: { name: item.name, arguments: item.arguments || "{}" },
        };
        const last = messages[messages.length - 1];
        if (last && last.role === "assistant" && Array.isArray(last.tool_calls)) last.tool_calls.push(call);
        else messages.push({ role: "assistant", content: null, tool_calls: [call] });
      } else if (item.type === "function_call_output") {
        let output = "";
        if (typeof item.output === "string") output = item.output;
        else if (Array.isArray(item.output)) {
          for (const part of item.output) if (part?.text) output += part.text;
        } else if (item.output && typeof item.output === "object") output = JSON.stringify(item.output);
        messages.push({ role: "tool", tool_call_id: item.call_id, content: output });
      }
    }
  }
  const firstNonSystem = messages.find((m) => m.role !== "system");
  if (firstNonSystem && firstNonSystem.role === "assistant") {
    const systemCount = messages.filter((m) => m.role === "system").length;
    messages.splice(systemCount, 0, { role: "user", content: " " });
  }
  out.messages = messages;

  if (Array.isArray(body.tools)) {
    out.tools = body.tools
      .filter((t) => t && t.type === "function")
      .map((t) => ({
        type: "function",
        function: {
          name: t.name,
          description: t.description || "",
          parameters: t.parameters || { type: "object", properties: {} },
        },
      }));
  }
  return out;
}

export function convertOpenAIToResponses(response, originalModel, requestData) {
  const choice = response.choices?.[0] || {};
  const message = choice.message || {};
  const usage = response.usage || {};
  const output = [];
  if (message.reasoning_content) {
    output.push({
      type: "reasoning",
      id: `rs_${crypto.randomUUID()}`,
      summary: [{ type: "summary_text", text: message.reasoning_content }],
    });
  }
  if (message.content) {
    output.push({
      type: "message",
      id: `msg_${crypto.randomUUID()}`,
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: message.content, annotations: [] }],
    });
  }
  if (Array.isArray(message.tool_calls)) {
    for (const tc of message.tool_calls) {
      output.push({
        type: "function_call",
        id: `fc_${crypto.randomUUID()}`,
        call_id: tc.id,
        name: tc.function?.name || "",
        arguments: tc.function?.arguments || "{}",
        status: "completed",
      });
    }
  }
  const incomplete = choice.finish_reason === "length";
  return {
    id: `resp_${crypto.randomUUID()}`,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status: incomplete ? "incomplete" : "completed",
    model: originalModel,
    output,
    usage: {
      input_tokens: usage.prompt_tokens || 0,
      input_tokens_details: { cached_tokens: usage.prompt_tokens_details?.cached_tokens || 0 },
      output_tokens: usage.completion_tokens || 0,
      output_tokens_details: {
        reasoning_tokens: usage.completion_tokens_details?.reasoning_tokens || 0,
      },
      total_tokens: usage.total_tokens || 0,
    },
    error: null,
    incomplete_details: incomplete ? { reason: "max_output_tokens" } : null,
    instructions: requestData?.instructions ?? null,
    parallel_tool_calls: requestData?.parallel_tool_calls ?? null,
    temperature: requestData?.temperature ?? null,
    top_p: requestData?.top_p ?? null,
    tool_choice: requestData?.tool_choice ?? null,
    tools: requestData?.tools ?? null,
  };
}

export function estimateAnthropicTokens(body) {
  let chars = 0;
  if (body.system) {
    if (typeof body.system === "string") chars += body.system.length;
    else if (Array.isArray(body.system)) {
      for (const b of body.system) if (b.type === "text" && b.text) chars += b.text.length;
    }
  }
  for (const msg of body.messages || []) {
    if (typeof msg.content === "string") chars += msg.content.length;
    else if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === "text" && block.text) chars += block.text.length;
        else if (block.type === "thinking" && block.thinking) chars += block.thinking.length;
        else if (block.type === "image") {
          if (block.source?.data) chars += Math.ceil(block.source.data.length / 4);
        } else if (block.type === "tool_use") chars += JSON.stringify(block.input || {}).length;
        else if (block.type === "tool_result") {
          if (typeof block.content === "string") chars += block.content.length;
          else if (Array.isArray(block.content)) {
            for (const c of block.content) if (c.type === "text" && c.text) chars += c.text.length;
          }
        }
      }
    }
  }
  for (const tool of body.tools || []) {
    chars += (tool.name || "").length + (tool.description || "").length;
    chars += JSON.stringify(tool.input_schema || {}).length;
  }
  return Math.ceil(chars / 3);
}

function readWithTimeout(reader, timeoutMs) {
  let timer;
  const read = reader.read();
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      try {
        reader.cancel();
      } catch {
        // 已关闭
      }
      reject(new Error("Stream read timed out"));
    }, timeoutMs);
  });
  return Promise.race([read, timeout]).finally(() => clearTimeout(timer));
}

function pumpTransform(upstreamBody, { onStart, onLine, onEnd, onError, onCancel }) {
  const reader = upstreamBody.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  let pingInterval = null;

  return new ReadableStream({
    start(controller) {
      onStart(controller, encoder);
      pingInterval = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(": ping\n\n"));
        } catch {
          // 已关闭
        }
      }, 10000);
    },
    async pull(controller) {
      try {
        while (true) {
          const result = await readWithTimeout(reader, 120000);
          if (result.done) {
            if (buffer.trim()) {
              buffer = processLines(buffer, controller, encoder);
              if (buffer.trim()) controller.enqueue(encoder.encode(`${buffer.trim()}\n\n`));
            }
            if (pingInterval) {
              clearInterval(pingInterval);
              pingInterval = null;
            }
            onEnd(controller, encoder);
            try {
              controller.close();
            } catch {
              // 已关闭
            }
            break;
          }
          buffer += decoder.decode(result.value, { stream: true });
          buffer = processLines(buffer, controller, encoder);
          if (!buffer.includes("\n")) break;
        }
      } catch (e) {
        if (pingInterval) {
          clearInterval(pingInterval);
          pingInterval = null;
        }
        try {
          onError(controller, encoder, e);
        } catch {
          // 忽略二级异常
        }
        try {
          controller.close();
        } catch {
          // 已关闭
        }
      }
    },
    cancel() {
      if (pingInterval) {
        clearInterval(pingInterval);
        pingInterval = null;
      }
      onCancel();
      return reader.cancel();
    },
  });

  function processLines(data, controller, encoder) {
    const lines = data.split("\n");
    const remaining = lines.pop();
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (trimmed.startsWith("data: ")) {
        const payload = trimmed.slice(6);
        if (payload === "[DONE]") {
          onLine(controller, encoder, null);
          continue;
        }
        let chunk;
        try {
          chunk = JSON.parse(payload);
        } catch {
          continue;
        }
        try {
          onLine(controller, encoder, chunk);
        } catch {
          // 单帧转换失败不影响整条流
        }
      }
    }
    return remaining;
  }
}

export function anthropicStreamTransform(upstreamBody, modelName, onDone = () => {}) {
  const encoderRef = new TextEncoder();
  let messageId = `msg_${crypto.randomUUID()}`;
  let contentBlockIndex = -1;
  let currentToolCallId = null;
  let currentToolName = null;
  let currentToolArgs = "";
  let streamStarted = false;
  let blockStopSent = false;
  let finalEventSent = false;
  let thinkingBlockActive = false;
  let inputTokens = 0;
  let outputTokens = 0;
  let finishReason = null;

  const send = (controller, encoder, event, payload) =>
    controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`));

  function sendMessageStart(controller, encoder) {
    send(controller, encoder, "message_start", {
      type: "message_start",
      message: {
        id: messageId,
        type: "message",
        role: "assistant",
        content: [],
        model: modelName,
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: inputTokens, output_tokens: outputTokens },
      },
    });
  }

  function sendContentBlockStart(controller, encoder, blockType) {
    const block =
      blockType === "tool_use"
        ? { type: "tool_use", id: currentToolCallId, name: currentToolName, input: {} }
        : blockType === "thinking"
          ? { type: "thinking", thinking: "" }
          : { type: "text", text: "" };
    send(controller, encoder, "content_block_start", {
      type: "content_block_start",
      index: contentBlockIndex,
      content_block: block,
    });
  }

  function startThinking(controller, encoder) {
    if (!streamStarted) {
      sendMessageStart(controller, encoder);
      streamStarted = true;
    }
    if (!thinkingBlockActive) {
      contentBlockIndex++;
      sendContentBlockStart(controller, encoder, "thinking");
      thinkingBlockActive = true;
      blockStopSent = false;
    }
  }

  function startText(controller, encoder) {
    if (!streamStarted) {
      sendMessageStart(controller, encoder);
      contentBlockIndex++;
      sendContentBlockStart(controller, encoder, "text");
      streamStarted = true;
      blockStopSent = false;
    }
    if (thinkingBlockActive) {
      send(controller, encoder, "content_block_stop", {
        type: "content_block_stop",
        index: contentBlockIndex,
      });
      thinkingBlockActive = false;
      contentBlockIndex++;
      sendContentBlockStart(controller, encoder, "text");
      blockStopSent = false;
    }
    if (currentToolCallId) {
      send(controller, encoder, "content_block_stop", {
        type: "content_block_stop",
        index: contentBlockIndex,
      });
      currentToolCallId = null;
      currentToolName = null;
      currentToolArgs = "";
      contentBlockIndex++;
      sendContentBlockStart(controller, encoder, "text");
      blockStopSent = false;
    }
  }

  function sendFinal(controller, encoder) {
    if (finalEventSent) return;
    if (!streamStarted) {
      sendMessageStart(controller, encoder);
      contentBlockIndex++;
      sendContentBlockStart(controller, encoder, "text");
      streamStarted = true;
    }
    if (!blockStopSent) {
      send(controller, encoder, "content_block_stop", {
        type: "content_block_stop",
        index: contentBlockIndex,
      });
      blockStopSent = true;
    }
    const stopReason = currentToolCallId
      ? "tool_use"
      : finishReason === "length"
        ? "max_tokens"
        : "end_turn";
    send(controller, encoder, "message_delta", {
      type: "message_delta",
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { output_tokens: outputTokens },
    });
    send(controller, encoder, "message_stop", { type: "message_stop" });
    finalEventSent = true;
    onDone({ prompt_tokens: inputTokens, completion_tokens: outputTokens });
  }

  return pumpTransform(upstreamBody, {
    onStart() {},
    onLine(controller, encoder, chunk) {
      if (!chunk) {
        sendFinal(controller, encoder);
        return;
      }
      if (finalEventSent) return;
      if (chunk.error) {
        const info = typeof chunk.error === "string" ? { message: chunk.error } : chunk.error;
        const type = info.type === "service_unavailable" ? "overloaded_error" : info.type || "api_error";
        send(controller, encoder, "error", {
          type: "error",
          error: { type, message: info.message || "上游返回错误" },
        });
        finalEventSent = true;
        onDone({ prompt_tokens: inputTokens, completion_tokens: outputTokens });
        return;
      }
      if (chunk.usage) {
        inputTokens = chunk.usage.prompt_tokens || inputTokens;
        outputTokens = chunk.usage.completion_tokens || outputTokens;
      }
      const choice = chunk.choices?.[0];
      if (!choice) return;
      const delta = choice.delta || {};
      if (choice.finish_reason) finishReason = choice.finish_reason;

      if (Array.isArray(delta.tool_calls)) {
        if (!streamStarted) {
          sendMessageStart(controller, encoder);
          streamStarted = true;
        }
        for (const tc of delta.tool_calls) {
          if (tc.id) {
            if (currentToolCallId) {
              send(controller, encoder, "content_block_stop", {
                type: "content_block_stop",
                index: contentBlockIndex,
              });
              blockStopSent = true;
            }
            currentToolCallId = tc.id;
            currentToolName = tc.function?.name || "";
            currentToolArgs = "";
            contentBlockIndex++;
            blockStopSent = false;
            sendContentBlockStart(controller, encoder, "tool_use");
          }
          if (tc.function?.arguments) {
            currentToolArgs += tc.function.arguments;
            send(controller, encoder, "content_block_delta", {
              type: "content_block_delta",
              index: contentBlockIndex,
              delta: { type: "input_json_delta", partial_json: tc.function.arguments },
            });
          }
        }
      } else if (delta.reasoning_content) {
        startThinking(controller, encoder);
        send(controller, encoder, "content_block_delta", {
          type: "content_block_delta",
          index: contentBlockIndex,
          delta: { type: "thinking_delta", thinking: delta.reasoning_content },
        });
      } else if (delta.content) {
        startText(controller, encoder);
        send(controller, encoder, "content_block_delta", {
          type: "content_block_delta",
          index: contentBlockIndex,
          delta: { type: "text_delta", text: delta.content },
        });
      }

      if (choice.finish_reason) {
        if (thinkingBlockActive) {
          send(controller, encoder, "content_block_stop", {
            type: "content_block_stop",
            index: contentBlockIndex,
          });
          thinkingBlockActive = false;
        }
        if (currentToolCallId && currentToolArgs) {
          send(controller, encoder, "content_block_stop", {
            type: "content_block_stop",
            index: contentBlockIndex,
          });
          blockStopSent = true;
        }
      }
    },
    onEnd(controller, encoder) {
      sendFinal(controller, encoder);
    },
    onError(controller, encoder, e) {
      send(controller, encoder, "error", {
        type: "error",
        error: { type: "api_error", message: e?.message || String(e) },
      });
      finalEventSent = true;
      onDone({ prompt_tokens: inputTokens, completion_tokens: outputTokens });
    },
    onCancel() {
      onDone({ prompt_tokens: inputTokens, completion_tokens: outputTokens });
    },
  });
}

export function responsesStreamTransform(upstreamBody, originalModel, onDone = () => {}) {
  const responseId = `resp_${crypto.randomUUID()}`;
  const createdAt = Math.floor(Date.now() / 1000);
  let finalEventSent = false;
  let finishReason = null;
  let inputTokens = 0;
  let outputTokens = 0;
  let reasoningTokens = 0;
  let cacheReadTokens = 0;
  let totalTokens = 0;
  let nextOutputIndex = 0;
  let msgItem = null;
  let reasoningItem = null;
  const toolItems = new Map();
  const finalOutput = [];

  const sseEvent = (type, payload) => `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;

  function openMessage(controller, encoder) {
    const id = `msg_${crypto.randomUUID()}`;
    const outputIndex = nextOutputIndex++;
    msgItem = { id, outputIndex, text: "" };
    controller.enqueue(
      encoder.encode(
        sseEvent("response.output_item.added", {
          type: "response.output_item.added",
          output_index: outputIndex,
          item: { type: "message", id, role: "assistant", status: "in_progress", content: [] },
        })
      )
    );
    controller.enqueue(
      encoder.encode(
        sseEvent("response.content_part.added", {
          type: "response.content_part.added",
          item_id: id,
          output_index: outputIndex,
          content_index: 0,
          part: { type: "output_text", text: "", annotations: [] },
        })
      )
    );
  }

  function closeMessage(controller, encoder) {
    if (!msgItem) return;
    const { id, outputIndex, text } = msgItem;
    controller.enqueue(
      encoder.encode(
        sseEvent("response.output_text.done", {
          type: "response.output_text.done",
          item_id: id,
          output_index: outputIndex,
          content_index: 0,
          text,
        })
      )
    );
    controller.enqueue(
      encoder.encode(
        sseEvent("response.content_part.done", {
          type: "response.content_part.done",
          item_id: id,
          output_index: outputIndex,
          content_index: 0,
          part: { type: "output_text", text, annotations: [] },
        })
      )
    );
    const item = {
      type: "message",
      id,
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text, annotations: [] }],
    };
    controller.enqueue(
      encoder.encode(
        sseEvent("response.output_item.done", {
          type: "response.output_item.done",
          output_index: outputIndex,
          item,
        })
      )
    );
    finalOutput.push(item);
    msgItem = null;
  }

  function openReasoning(controller, encoder) {
    const id = `rs_${crypto.randomUUID()}`;
    const outputIndex = nextOutputIndex++;
    reasoningItem = { id, outputIndex, text: "" };
    controller.enqueue(
      encoder.encode(
        sseEvent("response.output_item.added", {
          type: "response.output_item.added",
          output_index: outputIndex,
          item: { type: "reasoning", id, summary: [] },
        })
      )
    );
    controller.enqueue(
      encoder.encode(
        sseEvent("response.reasoning_summary_part.added", {
          type: "response.reasoning_summary_part.added",
          item_id: id,
          output_index: outputIndex,
          summary_index: 0,
          part: { type: "summary_text", text: "" },
        })
      )
    );
  }

  function closeReasoning(controller, encoder) {
    if (!reasoningItem) return;
    const { id, outputIndex, text } = reasoningItem;
    controller.enqueue(
      encoder.encode(
        sseEvent("response.reasoning_summary_text.done", {
          type: "response.reasoning_summary_text.done",
          item_id: id,
          output_index: outputIndex,
          summary_index: 0,
          text,
        })
      )
    );
    controller.enqueue(
      encoder.encode(
        sseEvent("response.reasoning_summary_part.done", {
          type: "response.reasoning_summary_part.done",
          item_id: id,
          output_index: outputIndex,
          summary_index: 0,
          part: { type: "summary_text", text },
        })
      )
    );
    const item = { type: "reasoning", id, summary: [{ type: "summary_text", text }] };
    controller.enqueue(
      encoder.encode(
        sseEvent("response.output_item.done", {
          type: "response.output_item.done",
          output_index: outputIndex,
          item,
        })
      )
    );
    finalOutput.push(item);
    reasoningItem = null;
  }

  function openTool(controller, encoder, tc) {
    const id = `fc_${crypto.randomUUID()}`;
    const outputIndex = nextOutputIndex++;
    const item = {
      id,
      callId: tc.id || "",
      outputIndex,
      name: tc.function?.name || "",
      args: "",
    };
    toolItems.set(tc.index ?? 0, item);
    controller.enqueue(
      encoder.encode(
        sseEvent("response.output_item.added", {
          type: "response.output_item.added",
          output_index: outputIndex,
          item: {
            type: "function_call",
            id,
            call_id: item.callId,
            name: item.name,
            arguments: "",
            status: "in_progress",
          },
        })
      )
    );
    return item;
  }

  function closeTool(controller, encoder, item) {
    controller.enqueue(
      encoder.encode(
        sseEvent("response.function_call_arguments.done", {
          type: "response.function_call_arguments.done",
          item_id: item.id,
          output_index: item.outputIndex,
          arguments: item.args,
        })
      )
    );
    const doneItem = {
      type: "function_call",
      id: item.id,
      call_id: item.callId,
      name: item.name,
      arguments: item.args,
      status: "completed",
    };
    controller.enqueue(
      encoder.encode(
        sseEvent("response.output_item.done", {
          type: "response.output_item.done",
          output_index: item.outputIndex,
          item: doneItem,
        })
      )
    );
    finalOutput.push(doneItem);
  }

  function flushOpen(controller, encoder) {
    closeReasoning(controller, encoder);
    closeMessage(controller, encoder);
    for (const item of toolItems.values()) closeTool(controller, encoder, item);
    toolItems.clear();
  }

  function buildResponse(status) {
    return {
      id: responseId,
      object: "response",
      created_at: createdAt,
      status,
      model: originalModel,
      output: finalOutput,
      usage: {
        input_tokens: inputTokens,
        input_tokens_details: { cached_tokens: cacheReadTokens },
        output_tokens: outputTokens,
        output_tokens_details: { reasoning_tokens: reasoningTokens },
        total_tokens: totalTokens || inputTokens + outputTokens,
      },
      error: null,
      incomplete_details: status === "incomplete" ? { reason: "max_output_tokens" } : null,
      instructions: null,
      parallel_tool_calls: null,
      temperature: null,
      top_p: null,
      tool_choice: null,
      tools: null,
    };
  }

  function sendFinal(controller, encoder) {
    if (finalEventSent) return;
    flushOpen(controller, encoder);
    if (!finalOutput.length) {
      const id = `msg_${crypto.randomUUID()}`;
      const outputIndex = nextOutputIndex++;
      controller.enqueue(
        encoder.encode(
          sseEvent("response.output_item.added", {
            type: "response.output_item.added",
            output_index: outputIndex,
            item: { type: "message", id, role: "assistant", status: "in_progress", content: [] },
          })
        )
      );
      const emptyItem = {
        type: "message",
        id,
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "", annotations: [] }],
      };
      controller.enqueue(
        encoder.encode(
          sseEvent("response.output_item.done", {
            type: "response.output_item.done",
            output_index: outputIndex,
            item: emptyItem,
          })
        )
      );
      finalOutput.push(emptyItem);
    }
    const status = finishReason === "length" ? "incomplete" : "completed";
    controller.enqueue(
      encoder.encode(sseEvent("response.completed", { type: "response.completed", response: buildResponse(status) }))
    );
    finalEventSent = true;
    onDone({ prompt_tokens: inputTokens, completion_tokens: outputTokens });
  }

  return pumpTransform(upstreamBody, {
    onStart(controller, encoder) {
      controller.enqueue(
        encoder.encode(
          sseEvent("response.created", {
            type: "response.created",
            response: {
              id: responseId,
              object: "response",
              created_at: createdAt,
              status: "in_progress",
              model: originalModel,
              output: [],
            },
          })
        )
      );
    },
    onLine(controller, encoder, chunk) {
      if (!chunk) {
        sendFinal(controller, encoder);
        return;
      }
      if (finalEventSent) return;
      if (chunk.error) {
        const info = typeof chunk.error === "string" ? { message: chunk.error } : chunk.error;
        const response = buildResponse("failed");
        response.error = {
          code: info.code || "server_error",
          message: info.message || "上游返回错误",
        };
        controller.enqueue(
          encoder.encode(sseEvent("response.failed", { type: "response.failed", response }))
        );
        finalEventSent = true;
        onDone({ prompt_tokens: inputTokens, completion_tokens: outputTokens });
        return;
      }
      if (chunk.usage) {
        inputTokens = chunk.usage.prompt_tokens || 0;
        outputTokens = chunk.usage.completion_tokens || 0;
        reasoningTokens =
          chunk.usage.reasoning_tokens ?? chunk.usage.completion_tokens_details?.reasoning_tokens ?? 0;
        cacheReadTokens = chunk.usage.prompt_tokens_details?.cached_tokens ?? 0;
        totalTokens = chunk.usage.total_tokens || 0;
      }
      const choice = chunk.choices?.[0];
      if (!choice) return;
      const delta = choice.delta || {};
      if (choice.finish_reason) finishReason = choice.finish_reason;

      if (delta.reasoning_content) {
        closeMessage(controller, encoder);
        if (!reasoningItem) openReasoning(controller, encoder);
        reasoningItem.text += delta.reasoning_content;
        controller.enqueue(
          encoder.encode(
            sseEvent("response.reasoning_summary_text.delta", {
              type: "response.reasoning_summary_text.delta",
              item_id: reasoningItem.id,
              output_index: reasoningItem.outputIndex,
              summary_index: 0,
              delta: delta.reasoning_content,
            })
          )
        );
      }
      if (delta.content) {
        closeReasoning(controller, encoder);
        if (!msgItem) openMessage(controller, encoder);
        msgItem.text += delta.content;
        controller.enqueue(
          encoder.encode(
            sseEvent("response.output_text.delta", {
              type: "response.output_text.delta",
              item_id: msgItem.id,
              output_index: msgItem.outputIndex,
              content_index: 0,
              delta: delta.content,
            })
          )
        );
      }
      if (Array.isArray(delta.tool_calls)) {
        closeMessage(controller, encoder);
        closeReasoning(controller, encoder);
        for (const tc of delta.tool_calls) {
          let item = toolItems.get(tc.index ?? 0);
          if (!item) item = openTool(controller, encoder, tc);
          else if (tc.function?.name && !item.name) item.name = tc.function.name;
          if (tc.function?.arguments) {
            item.args += tc.function.arguments;
            controller.enqueue(
              encoder.encode(
                sseEvent("response.function_call_arguments.delta", {
                  type: "response.function_call_arguments.delta",
                  item_id: item.id,
                  output_index: item.outputIndex,
                  delta: tc.function.arguments,
                })
              )
            );
          }
        }
      }
      if (choice.finish_reason) flushOpen(controller, encoder);
    },
    onEnd(controller, encoder) {
      sendFinal(controller, encoder);
    },
    onError(controller, encoder, e) {
      const response = buildResponse("failed");
      response.error = { code: "server_error", message: e?.message || String(e) };
      controller.enqueue(
        encoder.encode(sseEvent("response.failed", { type: "response.failed", response }))
      );
      finalEventSent = true;
      onDone({ prompt_tokens: inputTokens, completion_tokens: outputTokens });
    },
    onCancel() {
      onDone({ prompt_tokens: inputTokens, completion_tokens: outputTokens });
    },
  });
}
