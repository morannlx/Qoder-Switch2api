/**
 * OpenAI / Anthropic 兼容反代网关（每个档位一个实例）。
 *
 * 端点：
 *  POST /v1/chat/completions   OpenAI Chat Completions（流式 / 非流式）
 *  POST /v1/responses          OpenAI Responses（Codex CLI）
 *  POST /v1/messages           Anthropic Messages（Claude Code CLI）
 *  GET  /v1/models             模型列表（默认 + 上游 + 额外放行）
 *  GET  /healthz               健康检查与可用账号数
 *
 * 账号池：健康轮转 + 失败冷却；401/403 触发一次 token 续期重试。
 */
import express from "express";
import { accountManager } from "../qoder/account.js";
import { streamChat } from "../qoder/chat.js";
import { resolveModelRequest } from "./models.js";
import { fetchModelList } from "../qoder/info.js";
import { recordUsage, usageStats } from "./usage.js";
import { loadJson, saveJson } from "../store.js";
import { randomUUID } from "node:crypto";

const DEFAULT_MODELS = [
  { id: "auto", displayName: "Auto（默认）", ownedBy: "qoder", source: "system" },
  { id: "lite", displayName: "Lite", ownedBy: "qoder", source: "system" },
];

let modelListCache = { domestic: { at: 0, models: [] }, international: { at: 0, models: [] } };
const MODEL_CACHE_MS = 10 * 60 * 1000;

/**
 * 真正的流式选号：首个内容事件前允许换号，一旦开始输出就不再切换。
 * onPick 在选定账号时立即回调，便于记录失败用量。
 */
async function* streamChatEvents(edition, model, req, onPick) {
  const editionValue = edition.value;
  const { key: upstreamModel, effort: modelEffort } = resolveModelRequest(model);
  const reasoningEffort = req.reasoningEffort || modelEffort;
  let lastError = "没有可用账号";
  let lastStatus = 503;
  let lastAccount = null;
  for (let i = 0; i < 3; i += 1) {
    const account = accountManager.pick(editionValue);
    if (!account) {
      yield { type: "failed", error: lastError, status: lastStatus, account: lastAccount };
      return;
    }
    lastAccount = account;
    onPick?.(account);
    if (account.tokenExpireAt && account.tokenExpireAt < Date.now() + 5 * 60 * 1000 && account.refreshToken) {
      await accountManager.tryRefresh(account.id);
    }
    const current = accountManager.get(account.id) || account;
    let started = false;
    let failed = null;
    try {
      for await (const event of streamChat({
        account: current,
        edition,
        model: upstreamModel,
        messages: req.messages,
        tools: req.tools,
        imageUrls: req.imageUrls,
        api: req.api,
        reasoningEffort,
        thinkingType: req.thinkingType,
        thinkingBudget: req.thinkingBudget,
      })) {
        if (event.type === "error") {
          failed = event.error;
          break;
        }
        if (event.type !== "usage") started = true;
        yield event;
      }
    } catch (e) {
      failed = String(e.message || e);
    }
    if (!failed) {
      accountManager.markSuccess(current.id);
      return;
    }
    const statusMatch = /HTTP (\d{3})/.exec(failed);
    const statusCode = statusMatch ? Number(statusMatch[1]) : 0;
    if ([400, 404, 413, 415, 422].includes(statusCode)) {
      yield {
        type: "failed",
        error: `${failed}（模型 ${model} 拒绝了请求，请检查上下文长度、工具/参数兼容性或更换模型）`,
        status: statusCode,
        account: current,
      };
      return;
    }
    accountManager.markFailure(current.id, statusCode, failed);
    if (statusCode === 401 || statusCode === 403) {
      await accountManager.tryRefresh(current.id);
    }
    if (started) {
      yield { type: "error", error: failed };
      return;
    }
    lastError = failed;
    lastStatus = statusCode >= 400 && statusCode < 600 ? statusCode : 502;
  }
  yield { type: "failed", error: lastError, status: lastStatus, account: lastAccount };
}

/** OpenAI Chat Completions 真流式输出 */
function streamChatCompletion({ res, edition, editionValue, model, messages, started, request, includeUsage }) {
  const completionId = `chatcmpl-${randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  let account = null;
  let headSent = false;
  let clientClosed = false;
  let usage = null;
  let content = "";
  let reasoning = "";
  let toolCalls = [];
  const send = (obj) => {
    if (!clientClosed) res.write(`data: ${JSON.stringify(obj)}\n\n`);
  };
  const ensureHead = () => {
    if (headSent || clientClosed) return;
    headSent = true;
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    send({
      id: completionId,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
    });
  };
  res.on("close", () => {
    clientClosed = true;
  });

  (async () => {
    try {
      for await (const event of streamChatEvents(edition, model, request, (picked) => {
        account = picked;
      })) {
        if (clientClosed) break;
        if (event.type === "failed" || event.type === "error") {
          const error = event.error || "上游请求失败";
          if (!headSent) {
            recordUsage({
              edition: editionValue,
              accountId: account?.id || "",
              accountName: accountDisplayName(account),
              model,
              success: false,
              error,
              durationMs: Date.now() - started,
              api: "chat",
            });
            res.status(event.status || 502).json(openAiError("upstream_error", error, event.status || 502));
          } else {
            send({ error: { message: error, type: "upstream_error" } });
            recordUsage({
              edition: editionValue,
              accountId: account?.id || "",
              accountName: accountDisplayName(account),
              model,
              success: false,
              error,
              durationMs: Date.now() - started,
              api: "chat",
            });
            res.end();
          }
          return;
        }
        ensureHead();
        if (event.type === "content") {
          content += event.text;
          send({
            id: completionId,
            object: "chat.completion.chunk",
            created,
            model,
            choices: [{ index: 0, delta: { content: event.text }, finish_reason: null }],
          });
        } else if (event.type === "reasoning") {
          reasoning += event.text;
          send({
            id: completionId,
            object: "chat.completion.chunk",
            created,
            model,
            choices: [{ index: 0, delta: { reasoning_content: event.text }, finish_reason: null }],
          });
        } else if (event.type === "tool_calls") {
          toolCalls = mergeToolCalls(toolCalls, event.toolCalls);
          send({
            id: completionId,
            object: "chat.completion.chunk",
            created,
            model,
            choices: [{ index: 0, delta: { tool_calls: event.toolCalls }, finish_reason: null }],
          });
        } else if (event.type === "usage") {
          usage = event.usage;
        }
      }
      ensureHead();
      send({
        id: completionId,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [{ index: 0, delta: {}, finish_reason: toolCalls.length > 0 ? "tool_calls" : "stop" }],
      });
      // usage 收尾帧：OpenAI 的 include_usage 契约要求它在 finish 帧之后、
      // [DONE] 之前，且 choices 必须为空。ZCode 等客户端只认这一帧来算上下文
      // 用量（contextUsed），把 usage 挂在带 choices 的块上会被直接丢弃，
      // 表现为上下文条永远不显示。客户端没显式要也发：空 choices 的 usage
      // 块对 OpenAI 兼容客户端是合法帧，缺了它的代价才是真的。
      if (usage && includeUsage !== false) {
        send({
          id: completionId,
          object: "chat.completion.chunk",
          created,
          model,
          choices: [],
          usage: chatUsage(usage, messages, content),
        });
      }
      if (!clientClosed) {
        res.write("data: [DONE]\n\n");
        res.end();
      }
      recordUsage({
        edition: editionValue,
        accountId: account?.id || "",
        accountName: accountDisplayName(account),
        model,
        ...tokenUsage(usage, messages, content),
        durationMs: Date.now() - started,
        success: true,
        api: "chat",
      });
    } catch (e) {
      const error = String(e.message || e);
      if (!headSent) {
        recordUsage({
          edition: editionValue,
          accountId: account?.id || "",
          accountName: accountDisplayName(account),
          model,
          success: false,
          error,
          durationMs: Date.now() - started,
          api: "chat",
        });
        res.status(502).json(openAiError("upstream_error", error, 502));
      } else {
        send({ error: { message: error, type: "upstream_error" } });
        res.end();
      }
    }
  })();
}

/** Anthropic Messages 真流式输出 */
function streamAnthropic({ res, edition, editionValue, model, messages, started, request }) {
  const msgId = `msg-${randomUUID()}`;
  let account = null;
  let headSent = false;
  let clientClosed = false;
  let usage = null;
  let content = "";
  let thinking = "";
  let toolCalls = [];
  // 块索引与开闭状态：thinking 必须在 text 之前关闭，text 必须在 tool_use 之前关闭
  let nextIndex = 0;
  let thinkingIndex = null;
  let textIndex = null;
  let openToolBlocks = [];

  const write = (type, obj) => {
    if (clientClosed) return;
    res.write(`event: ${type}\ndata: ${JSON.stringify(obj)}\n\n`);
  };
  const ensureHead = () => {
    if (headSent || clientClosed) return;
    headSent = true;
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    // message_start 必须先发：ZCode 在它到达时初始化 usage 累加器
    write("message_start", {
      type: "message_start",
      message: {
        id: msgId,
        type: "message",
        role: "assistant",
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    });
  };
  const closeThinking = () => {
    if (thinkingIndex == null) return;
    write("content_block_stop", { type: "content_block_stop", index: thinkingIndex });
    thinkingIndex = null;
  };
  const closeText = () => {
    if (textIndex == null) return;
    write("content_block_stop", { type: "content_block_stop", index: textIndex });
    textIndex = null;
  };
  res.on("close", () => {
    clientClosed = true;
  });

  (async () => {
    try {
      for await (const event of streamChatEvents(edition, model, request, (picked) => {
        account = picked;
      })) {
        if (clientClosed) break;
        if (event.type === "failed" || event.type === "error") {
          const error = event.error || "上游请求失败";
          if (!headSent) {
            recordUsage({
              edition: editionValue,
              accountId: account?.id || "",
              accountName: accountDisplayName(account),
              model,
              success: false,
              error,
              durationMs: Date.now() - started,
              api: "messages",
            });
            res.status(event.status || 502).json(anthropicError("api_error", error, event.status || 502));
          } else {
            write("error", { type: "error", error: { type: "api_error", message: error } });
            recordUsage({
              edition: editionValue,
              accountId: account?.id || "",
              accountName: accountDisplayName(account),
              model,
              success: false,
              error,
              durationMs: Date.now() - started,
              api: "messages",
            });
            res.end();
          }
          return;
        }
        ensureHead();
        if (event.type === "reasoning") {
          if (thinkingIndex == null) {
            closeText();
            thinkingIndex = nextIndex;
            nextIndex += 1;
            write("content_block_start", {
              type: "content_block_start",
              index: thinkingIndex,
              content_block: { type: "thinking", thinking: "" },
            });
          }
          thinking += event.text;
          write("content_block_delta", {
            type: "content_block_delta",
            index: thinkingIndex,
            delta: { type: "thinking_delta", thinking: event.text },
          });
        } else if (event.type === "content") {
          closeThinking();
          if (textIndex == null) {
            textIndex = nextIndex;
            nextIndex += 1;
            write("content_block_start", {
              type: "content_block_start",
              index: textIndex,
              content_block: { type: "text", text: "" },
            });
          }
          content += event.text;
          write("content_block_delta", {
            type: "content_block_delta",
            index: textIndex,
            delta: { type: "text_delta", text: event.text },
          });
        } else if (event.type === "tool_calls") {
          closeThinking();
          closeText();
          toolCalls = mergeToolCalls(toolCalls, event.toolCalls);
          // 上游以增量分片给出参数；index 相同即同一个调用
          for (const call of Array.isArray(event.toolCalls) ? event.toolCalls : [event.toolCalls]) {
            const index = call.index ?? 0;
            while (openToolBlocks.length <= index) {
              openToolBlocks.push({ blockIndex: null, id: "", name: "" });
            }
            const slot = openToolBlocks[index];
            if (slot.blockIndex == null) {
              slot.blockIndex = nextIndex;
              nextIndex += 1;
              slot.id = call.id || `toolu_${slot.blockIndex}`;
              slot.name = call.function?.name || "";
              write("content_block_start", {
                type: "content_block_start",
                index: slot.blockIndex,
                content_block: { type: "tool_use", id: slot.id, name: slot.name, input: {} },
              });
            }
            if (call.id) slot.id = call.id;
            if (call.function?.name) slot.name = call.function.name;
            const args = call.function?.arguments;
            if (args) {
              write("content_block_delta", {
                type: "content_block_delta",
                index: slot.blockIndex,
                delta: { type: "input_json_delta", partial_json: args },
              });
            }
          }
        } else if (event.type === "usage") {
          usage = event.usage;
        }
      }
      ensureHead();
      closeThinking();
      closeText();
      for (const slot of openToolBlocks) {
        if (slot.blockIndex != null) {
          write("content_block_stop", { type: "content_block_stop", index: slot.blockIndex });
        }
      }
      const tokens = tokenUsage(usage, messages, content || thinking);
      const anthropicTokens = anthropicUsage(usage, tokens);      write("message_delta", {
        type: "message_delta",
        delta: { stop_reason: toolCalls.length > 0 ? "tool_use" : "end_turn", stop_sequence: null },
        usage: anthropicTokens,
      });
      write("message_stop", { type: "message_stop" });
      if (!clientClosed) res.end();
      recordUsage({
        edition: editionValue,
        accountId: account?.id || "",
        accountName: accountDisplayName(account),
        model,
        ...tokens,
        durationMs: Date.now() - started,
        success: true,
        api: "messages",
      });
    } catch (e) {
      const error = String(e.message || e);
      if (!headSent) {
        recordUsage({
          edition: editionValue,
          accountId: account?.id || "",
          accountName: accountDisplayName(account),
          model,
          success: false,
          error,
          durationMs: Date.now() - started,
          api: "messages",
        });
        res.status(502).json(anthropicError("api_error", error, 502));
      } else {
        write("error", { type: "error", error: { type: "api_error", message: error } });
        res.end();
      }
    }
  })();
}

export function createGateway(edition, getProxyConfig) {
  const editionValue = edition.value;
  const app = express();
  app.use(express.json({ limit: "32mb" }));
  app.use(express.text({ limit: "32mb", type: ["text/*"] }));

  /* ---------------- CORS ---------------- */
  app.use((req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader(
      "Access-Control-Allow-Headers",
      "authorization, content-type, x-api-key, anthropic-version, anthropic-beta, x-request-id",
    );
    res.setHeader("Access-Control-Max-Age", "86400");
    if (req.method === "OPTIONS") return res.status(204).end();
    next();
  });

  /* ---------------- 鉴权 ---------------- */
  app.use((req, res, next) => {
    const config = getProxyConfig(editionValue);
    if (!config.apiKey) return next();
    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : req.headers["x-api-key"] || "";
    if (token === config.apiKey) return next();
    if (req.path.startsWith("/v1/messages")) {
      return res.status(401).json(anthropicError("authentication_error", "API Key 无效", 401));
    }
    return res.status(401).json(openAiError("invalid_api_key", "API Key 无效", 401));
  });

  /* ---------------- 健康检查 ---------------- */
  app.get("/healthz", (req, res) => {
    const config = getProxyConfig(editionValue);
    const counts = accountManager.counts();
    res.json({
      ok: true,
      edition: editionValue,
      label: edition.label,
      accounts: editionValue === "domestic" ? counts.proxyDomestic : counts.proxyInternational,
      models: (config.extraModels || []).length + DEFAULT_MODELS.length,
    });
  });

  /* ---------------- 模型列表 ---------------- */
  app.get("/v1/models", async (req, res) => {
    const config = getProxyConfig(editionValue);
    const models = [...DEFAULT_MODELS];
    // 上游模型列表（缓存 10 分钟）
    const cached = modelListCache[editionValue];
    if (cached.at && Date.now() - cached.at < MODEL_CACHE_MS) {
      for (const m of cached.models) if (!models.some((x) => x.id === m.id)) models.push(m);
    } else {
      const account = accountManager.pick(editionValue);
      if (account) {
        try {
          const upstream = await fetchModelList(edition, account);
          modelListCache[editionValue] = { at: Date.now(), models: upstream };
          for (const m of upstream) if (!models.some((x) => x.id === m.id)) models.push(m);
        } catch {
          /* 上游不可达时只用默认列表 */
        }
      }
    }
    for (const id of config.extraModels || []) {
      if (id && !models.some((x) => x.id === id)) models.push({ id, displayName: id, ownedBy: "qoder", extra: true });
    }
    res.json({
      object: "list",
      data: models.map((m) => modelEntry(m, editionValue)),
    });
  });
  /* ---------------- Anthropic token 计数 ---------------- */
  app.post("/v1/messages/count_tokens", (req, res) => {
    let body = req.body || {};
    if (typeof body === "string") {
      try {
        body = JSON.parse(body);
      } catch {
        return res.status(400).json(anthropicError("invalid_request_error", "请求体不是合法 JSON", 400));
      }
    }
    const messages = anthropicToMessages(body);
    const extras = JSON.stringify(body.system ?? "") + JSON.stringify(body.tools ?? []);
    res.json({
      input_tokens: estimateTokens(messages) + Math.ceil(extras.length / 4),
    });
  });

  /* ---------------- Chat Completions ---------------- */
  app.post("/v1/chat/completions", async (req, res) => {
    const started = Date.now();
    let body = req.body || {};
    if (typeof body === "string") {
      try {
        body = JSON.parse(body);
      } catch {
        return res.status(400).json(openAiError("invalid_json", "请求体不是合法 JSON", 400));
      }
    }
    const model = (body.model || "auto").trim();
    const wantStream = Boolean(body.stream);
    const messages = normalizeMessages(body.messages || []);
    const imageUrls = collectImageUrls(messages);

    const upstreamRequest = {
      messages,
      tools: body.tools,
      reasoningEffort: body.reasoning_effort,
      thinkingType: body.thinking?.type,
      thinkingBudget: body.thinking?.budget_tokens,
      imageUrls,
      api: "chat",
    };

    if (wantStream) {
      const includeUsage = body.stream_options?.include_usage !== false;
      return streamChatCompletion({
        res,
        edition,
        editionValue,
        model,
        messages,
        started,
        request: upstreamRequest,
        includeUsage,
      });
    }

    const attempt = await runWithAccount(edition, model, upstreamRequest);
    if (!attempt.ok) {
      recordUsage({
        edition: editionValue,
        accountId: attempt.account?.id || "",
        accountName: accountDisplayName(attempt.account),
        model,
        success: false,
        error: attempt.error,
        durationMs: Date.now() - started,
        api: "chat",
      });
      return res.status(attempt.status || 502).json(openAiError("upstream_error", attempt.error, attempt.status || 502));
    }

    const { account, events } = attempt;
    const completionId = `chatcmpl-${randomUUID()}`;
    const created = Math.floor(Date.now() / 1000);
    const { content, reasoning, toolCalls, usage } = aggregate(events);
    const tokens = tokenUsage(usage, messages, content);
    recordUsage({
      edition: editionValue,
      accountId: account.id,
      accountName: accountDisplayName(account),
      model,
      ...tokens,
      durationMs: Date.now() - started,
      success: true,
      api: "chat",
    });
    return res.json({
      id: completionId,
      object: "chat.completion",
      created,
      model,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: content || null,
            ...(reasoning ? { reasoning_content: reasoning } : {}),
            ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
          },
          finish_reason: toolCalls.length > 0 ? "tool_calls" : "stop",
        },
      ],
      usage: chatUsage(usage, messages, content),
    });
  });

  /* ---------------- Responses（Codex CLI） ---------------- */
  app.post("/v1/responses", async (req, res) => {
    const started = Date.now();
    let body = req.body || {};
    if (typeof body === "string") {
      try {
        body = JSON.parse(body);
      } catch {
        return res.status(400).json(openAiError("invalid_json", "请求体不是合法 JSON", 400));
      }
    }
    const model = (body.model || "auto").trim();
    const messages = responsesToMessages(body);
    const imageUrls = collectImageUrls(messages);
    const wantStream = Boolean(body.stream);

    const attempt = await runWithAccount(edition, model, { messages, tools: body.tools, imageUrls, api: "responses" });
    if (!attempt.ok) {
      recordUsage({
        edition: editionValue,
        accountId: attempt.account?.id || "",
        accountName: accountDisplayName(attempt.account),
        model,
        success: false,
        error: attempt.error,
        durationMs: Date.now() - started,
        api: "responses",
      });
      return res
        .status(attempt.status || 502)
        .json(openAiError("upstream_error", attempt.error, attempt.status || 502));
    }
    const { account, events } = attempt;
    const { content, reasoning, toolCalls, usage } = aggregate(events);
    const tokens = tokenUsage(usage, messages, content);
    const responseId = `resp-${randomUUID()}`;
    const createdAt = Math.floor(Date.now() / 1000);
    recordUsage({
      edition: editionValue,
      accountId: account.id,
      accountName: accountDisplayName(account),
      model,
      ...tokens,
      durationMs: Date.now() - started,
      success: true,
      api: "responses",
    });

    const output = [
      ...(reasoning ? [{ type: "reasoning", summary: [{ type: "summary_text", text: reasoning }] }] : []),
      ...(content
        ? [{ type: "message", role: "assistant", content: [{ type: "output_text", text: content, annotations: [] }] }]
        : []),
      ...toolCalls.map((tc) => ({
        type: "function_call",
        id: tc.id,
        call_id: tc.id,
        name: tc.function?.name || "",
        arguments: tc.function?.arguments || "",
      })),
    ];

    if (!wantStream) {
      return res.json({
        id: responseId,
        object: "response",
        created_at: createdAt,
        status: "completed",
        model,
        output,
        usage: responsesUsage(usage, tokens),
      });
    }
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    const send = (type, obj) => res.write(`event: ${type}\ndata: ${JSON.stringify(obj)}\n\n`);
    send("response.created", { type: "response.created", response: { id: responseId, status: "in_progress", model } });
    if (content) {
      send("response.output_text.delta", {
        type: "response.output_text.delta",
        item_id: responseId,
        output_index: 0,
        content_index: 0,
        delta: content,
      });
    }
    send("response.completed", {
      type: "response.completed",
      response: { id: responseId, status: "completed", model, output, usage: responsesUsage(usage, tokens) },
    });
    res.write("data: [DONE]\n\n");
    res.end();
  });

  /* ---------------- Messages（Anthropic / Claude Code） ---------------- */
  app.post("/v1/messages", async (req, res) => {
    const started = Date.now();
    let body = req.body || {};
    if (typeof body === "string") {
      try {
        body = JSON.parse(body);
      } catch {
        return res.status(400).json(anthropicError("invalid_request_error", "请求体不是合法 JSON", 400));
      }
    }
    const model = (body.model || "auto").trim();
    const messages = anthropicToMessages(body);
    const imageUrls = collectImageUrls(messages);
    const tools = anthropicToolsToOpenAI(body.tools);
    const wantStream = Boolean(body.stream);
    const upstreamRequest = {
      messages,
      tools,
      imageUrls,
      api: "messages",
      // Claude Code / ZCode 把思考预算放在 thinking.budget_tokens 里
      thinkingType: body.thinking?.type,
      thinkingBudget: body.thinking?.budget_tokens,
      reasoningEffort: body.output_config?.effort,
    };

    if (wantStream) {
      return streamAnthropic({ res, edition, editionValue, model, messages, started, request: upstreamRequest });
    }

    const attempt = await runWithAccount(edition, model, upstreamRequest);
    if (!attempt.ok) {
      recordUsage({
        edition: editionValue,
        accountId: attempt.account?.id || "",
        accountName: accountDisplayName(attempt.account),
        model,
        success: false,
        error: attempt.error,
        durationMs: Date.now() - started,
        api: "messages",
      });
      return res
        .status(attempt.status || 502)
        .json(anthropicError("api_error", attempt.error, attempt.status || 502));
    }
    const { account, events } = attempt;
    const { content, reasoning, toolCalls, usage } = aggregate(events);
    const tokens = tokenUsage(usage, messages, content);
    const msgId = `msg-${randomUUID()}`;
    recordUsage({
      edition: editionValue,
      accountId: account.id,
      accountName: accountDisplayName(account),
      model,
      ...tokens,
      durationMs: Date.now() - started,
      success: true,
      api: "messages",
    });

    const contentBlocks = [];
    if (reasoning) contentBlocks.push({ type: "thinking", thinking: reasoning });
    if (content) contentBlocks.push({ type: "text", text: content });
    for (const tc of toolCalls) {
      contentBlocks.push({ type: "tool_use", id: tc.id, name: tc.function?.name || "", input: safeJson(tc.function?.arguments) });
    }
    if (contentBlocks.length === 0) contentBlocks.push({ type: "text", text: "" });

    if (!wantStream) {
      return res.json({
        id: msgId,
        type: "message",
        role: "assistant",
        model,
        content: contentBlocks,
        stop_reason: toolCalls.length > 0 ? "tool_use" : "end_turn",
        usage: anthropicUsage(usage, tokens),
      });
    }
  });

  /* ---------------- 用量统计（仅本机管理用） ---------------- */
  app.get("/usage-stats", (req, res) => {
    res.json(usageStats(editionValue));
  });

  return app;
}

/* ================================================================= */
/* 账号选择与上游调用                                                  */
/* ================================================================= */

async function runWithAccount(edition, model, req) {
  const editionValue = edition.value;
  const { key: upstreamModel, effort: modelEffort } = resolveModelRequest(model);
  const reasoningEffort = req.reasoningEffort || modelEffort;
  const maxAttempts = 3;
  let lastError = "没有可用账号";
  let lastStatus = 503;
  let lastAccount = null;
  for (let i = 0; i < maxAttempts; i += 1) {
    const account = accountManager.pick(editionValue);
    if (!account) {
      // 已经发生过真实上游错误时，把真实错误/状态码透传给客户端，而不是统一吞成 503
      if (i > 0 && lastError && lastError !== "没有可用账号") {
        return { ok: false, error: lastError, status: lastStatus, account: lastAccount };
      }
      return { ok: false, error: `没有可用的${edition.label}账号：请先在账号管理页添加账号，或检查账号状态/冷却`, status: 503, account: null };
    }
    lastAccount = account;
    // token 即将过期且有刷新令牌时先续期
    if (account.tokenExpireAt && account.tokenExpireAt < Date.now() + 5 * 60 * 1000 && account.refreshToken) {
      await accountManager.tryRefresh(account.id);
    }
    const events = [];
    let failed = null;
    try {
      for await (const event of streamChat({
        account,
        edition,
        model: upstreamModel,
        messages: req.messages,
        tools: req.tools,
        imageUrls: req.imageUrls,
        api: req.api,
        reasoningEffort,
        thinkingType: req.thinkingType,
        thinkingBudget: req.thinkingBudget,
      })) {
        if (event.type === "error") {
          failed = event.error;
          break;
        }
        events.push(event);
      }
    } catch (e) {
      failed = String(e.message || e);
    }
    if (!failed) {
      accountManager.markSuccess(account.id);
      return { ok: true, account, events };
    }
    // 失败：先判断是否为请求/模型本身的错误
    const statusMatch = /HTTP (\d{3})/.exec(failed);
    const statusCode = statusMatch ? Number(statusMatch[1]) : 0;
    if ([400, 404, 413, 415, 422].includes(statusCode)) {
      // 换号也不会成功，且不应把健康账号打进冷却
      const detail = `${failed}（模型 ${model} 拒绝了请求，已停止重试；请检查上下文长度、工具/参数兼容性或更换模型）`;
      return { ok: false, error: detail, status: statusCode, account };
    }
    accountManager.markFailure(account.id, statusCode, failed);
    if (statusCode === 401 || statusCode === 403) {
      const refreshed = await accountManager.tryRefresh(account.id);
      if (refreshed && i === 0) {
        // 续期成功，立刻用同一账号再试一次
        const retryEvents = [];
        let retryFailed = null;
        try {
          for await (const event of streamChat({
            account: accountManager.get(account.id),
            edition,
            model: upstreamModel,
            messages: req.messages,
            tools: req.tools,
            imageUrls: req.imageUrls,
            api: req.api,
            reasoningEffort,
          })) {
            if (event.type === "error") {
              retryFailed = event.error;
              break;
            }
            retryEvents.push(event);
          }
        } catch (e) {
          retryFailed = String(e.message || e);
        }
        if (!retryFailed) {
          accountManager.markSuccess(account.id);
          return { ok: true, account: accountManager.get(account.id), events: retryEvents };
        }
        failed = retryFailed;
      }
    }
    lastError = failed;
    lastStatus = statusCode >= 400 && statusCode < 600 ? statusCode : 502;
  }
  return { ok: false, error: lastError, status: lastStatus, account: lastAccount };
}

/** 用量记账里的账号显示名：名称缺失时逐级回退，避免出现「未知账号」 */
function accountDisplayName(account) {
  if (!account) return "无可用账号";
  return (
    account.name ||
    account.email ||
    account.phone ||
    account.label ||
    account.uid ||
    account.id ||
    "未知账号"
  );
}

/* ================================================================= */
/* 格式转换工具                                                        */
/* ================================================================= */

function normalizeMessages(messages) {
  return (messages || []).map((m) => ({
    role: m.role || "user",
    content: m.content ?? "",
    tool_calls: m.tool_calls,
    tool_call_id: m.tool_call_id,
  }));
}

function collectImageUrls(messages) {
  const urls = [];
  for (const m of messages) {
    if (Array.isArray(m.content)) {
      for (const part of m.content) {
        if (part?.type === "image_url") {
          const url = typeof part.image_url === "string" ? part.image_url : part.image_url?.url;
          if (url) urls.push(url);
        }
      }
    }
  }
  return urls;
}

function aggregate(events) {
  let content = "";
  let reasoning = "";
  let toolCalls = [];
  let usage = null;
  for (const event of events) {
    if (event.type === "content") content += event.text;
    else if (event.type === "reasoning") reasoning += event.text;
    else if (event.type === "tool_calls") toolCalls = mergeToolCalls(toolCalls, event.toolCalls);
    else if (event.type === "usage") usage = event.usage;
  }
  return { content, reasoning, toolCalls, usage };
}

function mergeToolCalls(acc, incoming) {
  const list = Array.isArray(acc) ? [...acc] : [];
  const items = Array.isArray(incoming) ? incoming : [incoming];
  for (const call of items) {
    const index = call.index ?? list.length;
    while (list.length <= index) {
      list.push({ index: list.length, id: "", type: "function", function: { name: "", arguments: "" } });
    }
    const target = list[index];
    if (call.id) target.id = call.id;
    if (call.type) target.type = call.type;
    if (call.function?.name) target.function.name = call.function.name;
    if (call.function?.arguments) target.function.arguments += call.function.arguments;
  }
  return list;
}

/** Responses API 请求 → 内部消息列表 */
function responsesToMessages(body) {
  const messages = [];
  if (body.instructions) messages.push({ role: "system", content: body.instructions });
  const input = body.input;
  if (typeof input === "string") {
    messages.push({ role: "user", content: input });
  } else if (Array.isArray(input)) {
    for (const item of input) {
      if (!item || typeof item !== "object") continue;
      if (item.role) {
        const content = typeof item.content === "string" ? item.content : extractText(item.content);
        messages.push({ role: item.role, content });
      } else if (item.type === "function_call_output") {
        messages.push({ role: "tool", tool_call_id: item.call_id || "", content: String(item.output ?? "") });
      } else if (item.type === "message" && item.content) {
        messages.push({ role: item.role || "user", content: extractText(item.content) });
      }
    }
  }
  if (messages.length === 0) messages.push({ role: "user", content: " " });
  return messages;
}

/** Anthropic Messages 请求 → 内部消息列表 */
/** Anthropic {name,input_schema} → OpenAI {type:function,function:{name,parameters}} */
function anthropicToolsToOpenAI(tools) {
  if (!Array.isArray(tools)) return tools;
  return tools
    .map((tool) => {
      if (!tool || typeof tool !== "object") return null;
      if (tool.type === "function" && tool.function?.name) return tool;
      const name = tool.name || tool.function?.name;
      if (!name) return null;
      return {
        type: "function",
        function: {
          name,
          description: tool.description || "",
          parameters: tool.input_schema || tool.parameters || { type: "object", properties: {} },
        },
      };
    })
    .filter(Boolean);
}

function anthropicToMessages(body) {
  const messages = [];
  if (body.system) {
    const text = typeof body.system === "string" ? body.system : extractText(body.system);
    if (text) messages.push({ role: "system", content: text });
  }
  for (const m of body.messages || []) {
    const role = m.role === "assistant" ? "assistant" : "user";
    if (typeof m.content === "string") {
      messages.push({ role, content: m.content });
      continue;
    }
    if (Array.isArray(m.content)) {
      const parts = [];
      for (const block of m.content) {
        if (block?.type === "text") parts.push({ type: "text", text: block.text || "" });
        else if (block?.type === "image") {
          const url = block.source?.url || (block.source?.data ? `data:${block.source.media_type || "image/png"};base64,${block.source.data}` : "");
          if (url) parts.push({ type: "image_url", image_url: { url } });
        } else if (block?.type === "tool_use") {
          messages.push({ role, content: "", tool_calls: [{ id: block.id, type: "function", function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) } }] });
        } else if (block?.type === "tool_result") {
          const text = typeof block.content === "string" ? block.content : extractText(block.content);
          messages.push({ role: "tool", tool_call_id: block.tool_use_id || "", content: text });
        }
      }
      if (parts.length > 0) messages.push({ role, content: parts.length === 1 && parts[0].type === "text" ? parts[0].text : parts });
    }
  }
  if (messages.length === 0) messages.push({ role: "user", content: " " });
  return messages;
}

function extractText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => (c?.type === "text" || c?.type === "output_text" ? c.text || "" : ""))
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function estimateTokens(messages) {
  let chars = 0;
  for (const m of messages) {
    if (typeof m.content === "string") chars += m.content.length;
    else if (Array.isArray(m.content)) chars += JSON.stringify(m.content).length;
  }
  return Math.ceil(chars / 4);
}

/** 上游未返回 usage 时使用估算值，且保证 total = prompt + completion */
function tokenUsage(usage, messages, content) {
  const promptTokens = usage?.promptTokens || estimateTokens(messages);
  const completionTokens = usage?.completionTokens || estimateTokens([{ role: "assistant", content }]);
  return {
    promptTokens,
    completionTokens,
    totalTokens: usage?.totalTokens || promptTokens + completionTokens,
  };
}

/**
 * OpenAI 形状的 usage 块（流式收尾帧与非流式响应共用）。
 *
 * prompt_tokens 按 OpenAI 语义**含**缓存命中部分，缓存命中同时写进
 * prompt_tokens_details.cached_tokens —— ZCode / Cherry Studio / LobeChat
 * 都从这里读 cacheReads，读不到就当成「没有缓存」，上下文条与命中率都不对。
 */
function chatUsage(usage, messages, content) {
  const tokens = tokenUsage(usage, messages, content);
  const cached = Math.min(usage?.cachedTokens || 0, tokens.promptTokens);
  const block = {
    prompt_tokens: tokens.promptTokens,
    completion_tokens: tokens.completionTokens,
    total_tokens: tokens.totalTokens,
  };
  if (cached > 0) {
    block.prompt_tokens_details = { cached_tokens: cached };
    // 兼容别名：部分客户端只认下面两种拼写
    block.cache_read_input_tokens = cached;
    block.cached_tokens = cached;
  }
  const reasoning = usage?.reasoningTokens || 0;
  if (reasoning > 0) block.completion_tokens_details = { reasoning_tokens: reasoning };
  return block;
}

function safeJson(raw) {
  try {
    return typeof raw === "string" ? JSON.parse(raw) : raw ?? {};
  } catch {
    return {};
  }
}

/**
 * Anthropic 形状的 usage 块。
 *
 * Anthropic 的 input_tokens 是**未命中缓存**的那部分，客户端把
 * input + cache_read + cache_creation 三者相加才是整段上下文。上游给的是
 * OpenAI 语义（prompt_tokens 已包含缓存命中），直接照抄会让上下文看起来
 * 是实际的两倍，所以要减掉命中部分。Qoder 不单独报缓存写入，命中数从
 * prompt_tokens_details.cached_tokens 读。
 */
function anthropicUsage(usage, tokens) {
  const cached = Math.min(usage?.cachedTokens || 0, tokens.promptTokens);
  return {
    input_tokens: Math.max(0, tokens.promptTokens - cached),
    output_tokens: tokens.completionTokens,
    cache_read_input_tokens: cached,
    cache_creation_input_tokens: 0,
  };
}

/**
 * 模型条目的上下文窗口。
 *
 * 上游 model_config.max_input_tokens 声明的是 180000（见 chat.js 的 legacy
 * 模板）。ZCode 的上下文条 = contextUsed / contextWindow，窗口取自
 * provider_config.json 里该模型的 properties.contextWindow；网关这边先把它
 * 作为一个常规字段广播出去（context_length / max_input_tokens 等多种拼写），
 * 客户端无论读哪种都能拿到同一个数。
 */
const MODEL_CONTEXT_WINDOW = 180000;
const MODEL_MAX_OUTPUT = 32768;

/** /v1/models 的单条记录：兼容各家客户端的字段拼写 */
function modelEntry(m, editionValue) {
  const id = m.id;
  const vision = m.isVl !== false;
  const reasoning = Boolean(m.isReasoning);
  return {
    id,
    object: "model",
    created: Math.floor(Date.now() / 1000),
    owned_by: m.ownedBy || "qoder",
    display_name: m.displayName || id,
    name: m.displayName || id,
    // 上下文窗口：各家拼写不同，全部给出
    context_length: MODEL_CONTEXT_WINDOW,
    max_input_tokens: MODEL_CONTEXT_WINDOW,
    max_output_tokens: MODEL_MAX_OUTPUT,
    max_completion_tokens: MODEL_MAX_OUTPUT,
    limit: { context: MODEL_CONTEXT_WINDOW, output: MODEL_MAX_OUTPUT },
    capabilities: { vision, tool_calls: true, reasoning },
    supports_vision: vision,
    supports_tool_calls: true,
    supports_reasoning: reasoning,
    input_modalities: vision ? ["text", "image"] : ["text"],
    output_modalities: ["text"],
    modalities: { input: vision ? ["text", "image"] : ["text"], output: ["text"] },
    edition: editionValue,
  };
}

/**
 * Responses 形状的 usage 块。
 *
 * Responses 与 OpenAI chat 同语义：input_tokens 已含缓存命中，命中数放在
 * input_tokens_details.cached_tokens（Codex 从 details 读缓存命中）。
 */
function responsesUsage(usage, tokens) {
  const cached = Math.min(usage?.cachedTokens || 0, tokens.promptTokens);
  return {
    input_tokens: tokens.promptTokens,
    input_tokens_details: { cached_tokens: cached },
    output_tokens: tokens.completionTokens,
    output_tokens_details: { reasoning_tokens: usage?.reasoningTokens || 0 },
    total_tokens: tokens.totalTokens,
  };
}

function openAiError(code, message, status) {
  return { error: { message, type: "api_error", code, status } };
}

function anthropicError(type, message, status) {
  return { type: "error", error: { type, message } };
}
