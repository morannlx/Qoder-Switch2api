/**
 * ZCode 客户端一键接入。
 *
 * ZCode 的自定义 provider 存在 ~/.zcode/v2/provider_config.json，分两处写：
 *
 *  1. config.providerConfigRules.providerRules[] —— provider 本身：协议
 *     （openai-chat-completions / anthropic-messages）、baseUrl、apiKey，
 *     以及模型清单 personalModelIds + modelOrder。按稳定 providerId 定位，
 *     重复 apply 只更新同一条，别的 provider 与顺序逐字保留。
 *
 *  2. config.modelConfigRules.providerModelRules[] —— **每个模型的属性**。
 *     这一处才是上下文条的关键：ZCode 用
 *       contextUsage = { used: contextUsed, size: model.properties.contextWindow }
 *     画上下文条，模型没声明 contextWindow 时回退到 2e5（不是上游真实窗口），
 *     而 contextUsed 来自每次请求的 usage。所以只写 provider、不写模型属性时
 *     会出现「有上下文条但窗口不对」，甚至因为用量恒为 0 而整条不显示。
 *
 * 已存在的同 baseUrl provider（用户手动加的）不会被再建一条：默认复用它的
 * providerId，用户的模型选择与顺序因此保持不变。
 *
 * provider_config.json 归 ZCode 自己所有、运行时会被重写，所以写之前要求
 * ZCode 已退出，写完提示重启。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { resolveModelRequest } from "./proxy/models.js";

/** 新建 provider 时使用的稳定 id（重复 apply 认它，不会堆叠） */
export const ZCODE_PROVIDER_ID = "qoder-switch2api";
export const ZCODE_PROVIDER_NAME = "Qoder";

/** 上游 model_config 声明的输入窗口（与 chat.js 的 legacy 模板一致） */
export const ZCODE_CONTEXT_WINDOW = 180000;
export const ZCODE_MAX_OUTPUT = 32768;

/** ~/.zcode/v2/ 目录（ZCode 3.x 的活配置目录） */
export function zcodeConfigDir() {
  return path.join(os.homedir(), ".zcode", "v2");
}

export function zcodeConfigPath() {
  return path.join(zcodeConfigDir(), "provider_config.json");
}

/** ZCode 是否装着（UI 用它决定是否展示接入入口） */
export function zcodeInstalled() {
  return fs.existsSync(path.join(os.homedir(), ".zcode"));
}

/**
 * ZCode 是否在运行。
 * 运行中写这份配置没有意义：ZCode 持有一份内存副本，下次保存会整个盖回去。
 */
export async function zcodeRunning() {
  const patterns = process.platform === "win32" ? ["ZCode.exe"] : ["ZCode", "zcode.cjs"];
  for (const pattern of patterns) {
    const found = await new Promise((resolve) => {
      execFile("pgrep", ["-f", pattern], (err, stdout) => {
        if (err) return resolve(false);
        // pgrep -f 会匹配到自己的命令行，过滤掉
        const pids = String(stdout)
          .split("\n")
          .map((s) => s.trim())
          .filter(Boolean);
        resolve(pids.length > 0);
      });
    });
    if (found) return true;
  }
  return false;
}

function readJson(file, fallback) {
  try {
    const text = fs.readFileSync(file, "utf8");
    if (!text.trim()) return fallback;
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

/** 原子写：先写临时文件再 rename，避免 ZCode 读到半截 JSON */
function writeJsonAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, file);
}

function normalizeBaseUrl(url) {
  return String(url || "")
    .trim()
    .replace(/\/+$/, "")
    .toLowerCase();
}

/**
 * 模型在接入配置里用哪个 id。
 *
 * 优先用 display name（`DeepSeek-Flash`）：它同时是网关别名表认的拼写，
 * 在 ZCode 的模型菜单里也比内部 key（`dfmodel`）可读，还能和用户此前手动
 * 加的条目对上。两个条件都满足才用：
 *   1. 别名表解析到同一个上游 key —— 否则请求会 400（如 `Step-5-Preview`）；
 *   2. 名字只含 ASCII 可见字符 —— `Auto（默认）` 这种当 id 会很难看也不好搜。
 */
function zcodeModelId(model) {
  const key = String(model.id || "").trim();
  const name = String(model.displayName || "").trim();
  if (!name || !key) return key;
  if (!/^[A-Za-z0-9._-]+$/.test(name)) return key;
  if (resolveModelRequest(name).key !== resolveModelRequest(key).key) return key;
  return name;
}

/**
 * 判断两个模型 id 是否指同一个模型。
 *
 * 用户此前手动加的条目可能是 `qwen3.8-flash`，而我们宣告的是 `qfmodel` ——
 * 字符串不同、上游 key 相同。按网关别名表解析后的 key 比较，才能把窗口补到
 * 他已在用的那一条上，而不是并排再建一条同名模型。
 */
function modelIdKey(id) {
  const raw = String(id || "").trim();
  if (!raw) return "";
  return resolveModelRequest(raw).key.toLowerCase();
}

/** 上游模型条目用 isVl，接入配置里用 vision：两种拼写都认 */
function supportsImage(model) {
  if (typeof model.vision === "boolean") return model.vision;
  return model.isVl !== false;
}

/**
 * 把一个上游模型条目转成「接入 ZCode 时的可选项」。
 *
 * UI 用它渲染勾选列表，apply 用它过滤用户选中的子集，zcodeStatus 也用它回读——
 * 三处必须是同一个形态，否则勾选项与最终写入的 id 会对不上。
 */
export function zcodeModelOption(model) {
  const label = String(model.displayName || model.id || "").trim();
  return {
    id: zcodeModelId(model),
    // 上游 key，仅用于展示「这个 id 对应哪个模型」，不写进配置
    upstreamKey: resolveModelRequest(model.id).key,
    label: label || model.id,
    contextWindow: model.contextWindow || ZCODE_CONTEXT_WINDOW,
    maxOutput: model.maxOutput || ZCODE_MAX_OUTPUT,
    vision: supportsImage(model),
    reasoning: Boolean(model.isReasoning),
  };
}

/** 在现有规则里找指向本网关的那一条（用户之前手动加过同地址的 provider） */
function findProviderRuleIndex(rules, baseUrl) {
  const target = normalizeBaseUrl(baseUrl);
  return rules.findIndex((rule) => {
    if (!rule || typeof rule !== "object") return false;
    if (rule.providerId === ZCODE_PROVIDER_ID) return true;
    const ruleUrl = normalizeBaseUrl(rule.config?.api?.baseUrl);
    return Boolean(target) && ruleUrl === target;
  });
}

/**
 * 把 provider 规则与模型属性合并进一份 provider_config。
 * 纯函数：不碰磁盘，便于测试与「预览将要写入什么」。
 */
export function mergeZcodeConfig(existing, { baseUrl, apiKey, protocol, models }) {
  const data =
    existing && typeof existing === "object" && !Array.isArray(existing) ? structuredClone(existing) : {};
  if (!data.schemaVersion) data.schemaVersion = 1;
  if (!data.config || typeof data.config !== "object") data.config = {};
  const config = data.config;

  // ---- 1. provider 规则 ----
  if (!config.providerConfigRules || typeof config.providerConfigRules !== "object") {
    config.providerConfigRules = { providerRules: [] };
  }
  const holder = config.providerConfigRules;
  if (!Array.isArray(holder.providerRules)) holder.providerRules = [];
  const rules = holder.providerRules;

  const modelIds = [...new Set((models || []).map((m) => m.id).filter(Boolean))];
  const existingIndex = findProviderRuleIndex(rules, baseUrl);
  // 复用既有 provider 的 id：用户的模型选择、会话记录都按它索引
  const providerId =
    existingIndex >= 0 && rules[existingIndex]?.providerId
      ? rules[existingIndex].providerId
      : ZCODE_PROVIDER_ID;

  const api = { type: protocol || "openai-chat-completions", baseUrl };
  const prevProvider = existingIndex >= 0 ? rules[existingIndex] || {} : {};
  const providerConfig = {
    group: "standard-personal",
    access: { type: "api-key", apiKey: apiKey || "" },
    api,
  };
  if (modelIds.length > 0) {
    // 用户此前在本 provider 里配过的模型原样保留（包括他写的拼写），
    // 新模型追加到末尾。用我们的 id 覆盖会让他已选的模型从菜单里消失。
    const prevList = prevProvider.config?.personalModelIds || [];
    const mergedIds = [...prevList];
    for (const id of modelIds) {
      const key = modelIdKey(id);
      if (!mergedIds.some((existing) => modelIdKey(existing) === key)) mergedIds.push(id);
    }
    const prevOrder = (prevProvider.config?.modelOrder || []).filter((id) =>
      mergedIds.some((x) => modelIdKey(x) === modelIdKey(id)),
    );
    providerConfig.personalModelIds = mergedIds;
    providerConfig.modelOrder = [
      ...prevOrder,
      ...mergedIds.filter((id) => !prevOrder.some((x) => modelIdKey(x) === modelIdKey(id))),
    ];
  }

  if (existingIndex >= 0) {
    rules[existingIndex] = {
      ...prevProvider,
      providerId,
      providerName: prevProvider.providerName || ZCODE_PROVIDER_NAME,
      config: { ...(prevProvider.config || {}), ...providerConfig },
    };
  } else {
    rules.push({
      providerId,
      providerName: ZCODE_PROVIDER_NAME,
      config: providerConfig,
    });
  }

  if (!Array.isArray(config.providerOrder)) config.providerOrder = [];
  if (!config.providerOrder.includes(providerId)) config.providerOrder.push(providerId);

  // ---- 2. 每个模型的属性（上下文窗口） ----
  if (!config.modelConfigRules || typeof config.modelConfigRules !== "object") {
    config.modelConfigRules = { providerModelRules: [] };
  }
  const modelHolder = config.modelConfigRules;
  if (!Array.isArray(modelHolder.providerModelRules)) modelHolder.providerModelRules = [];
  const modelRules = modelHolder.providerModelRules;

  for (const model of models || []) {
    const id = zcodeModelId(model);
    if (!id) continue;
    // 只声明 ZCode 真正会读、且我们确定的值：contextWindow 决定上下文条的
    // 分母；inputFormat.supportsImage 决定贴图是否被拒。其余能力项留空，
    // 让 ZCode 走它自己的默认值，避免宣告了上游其实不支持的形状。
    const properties = { contextWindow: model.contextWindow || ZCODE_CONTEXT_WINDOW };
    if (supportsImage(model)) {
      properties.inputFormat = {
        supportsText: true,
        supportsImage: true,
        supportsVideo: false,
        supportsAudio: false,
        supportsPdf: false,
      };
    }
    // 用户此前手动加过同一模型（拼写可能不同）时补到那一条上：
    // 覆盖成我们的 id 会把他的模型选择与历史记录断开
    const key = modelIdKey(id);
    const index = modelRules.findIndex(
      (r) => r && r.providerId === providerId && modelIdKey(r.modelId) === key,
    );
    const rule = {
      modelId: index >= 0 ? modelRules[index].modelId : id,
      providerId,
      config: { enabled: true, properties },
    };
    if (index >= 0) {
      // 合并而非覆盖：用户在 ZCode 里改过的其它能力项要留着
      const prev = modelRules[index] || {};
      modelRules[index] = {
        ...prev,
        ...rule,
        config: {
          ...(prev.config || {}),
          ...rule.config,
          properties: { ...(prev.config?.properties || {}), ...properties },
        },
      };
    } else {
      modelRules.push(rule);
    }
  }

  return data;
}

/**
 * 把本网关写进 ZCode 的 provider 配置。
 * @returns {{ path: string, created: boolean, providerId: string, modelCount: number }}
 */
export function applyZcode({ baseUrl, apiKey, protocol, models }) {
  const file = zcodeConfigPath();
  const existed = fs.existsSync(file);
  const existing = readJson(file, null);
  const merged = mergeZcodeConfig(existing, { baseUrl, apiKey, protocol, models });
  writeJsonAtomic(file, merged);
  const rule = merged.config.providerConfigRules.providerRules.find(
    (r) => normalizeBaseUrl(r?.config?.api?.baseUrl) === normalizeBaseUrl(baseUrl),
  );
  return {
    path: file,
    created: !existed,
    providerId: rule?.providerId || ZCODE_PROVIDER_ID,
    modelCount: (models || []).length,
  };
}

/** 从 provider_config 里删掉本网关（保留其余一切） */
export function removeZcode({ baseUrl, providerId } = {}) {
  const file = zcodeConfigPath();
  if (!fs.existsSync(file)) return { path: file, removed: false };
  const data = readJson(file, null);
  if (!data?.config) return { path: file, removed: false };

  const holder = data.config.providerConfigRules;
  const rules = holder?.providerRules;
  let targetId = providerId || "";
  if (!targetId && Array.isArray(rules)) {
    const rule = rules.find(
      (r) =>
        r?.providerId === ZCODE_PROVIDER_ID ||
        (baseUrl && normalizeBaseUrl(r?.config?.api?.baseUrl) === normalizeBaseUrl(baseUrl)),
    );
    targetId = rule?.providerId || "";
  }
  if (!targetId) return { path: file, removed: false };

  if (Array.isArray(rules)) {
    holder.providerRules = rules.filter((r) => r?.providerId !== targetId);
  }
  const modelHolder = data.config.modelConfigRules;
  if (modelHolder && Array.isArray(modelHolder.providerModelRules)) {
    modelHolder.providerModelRules = modelHolder.providerModelRules.filter(
      (r) => r?.providerId !== targetId,
    );
  }
  if (Array.isArray(data.config.providerOrder)) {
    data.config.providerOrder = data.config.providerOrder.filter((id) => id !== targetId);
  }
  writeJsonAtomic(file, data);
  return { path: file, removed: true, providerId: targetId };
}

/** 当前写了什么（UI 展示「已接入 / 未接入」、实际地址与窗口） */
export function zcodeStatus({ baseUrl } = {}) {
  const file = zcodeConfigPath();
  const data = fs.existsSync(file) ? readJson(file, null) : null;
  const rules = data?.config?.providerConfigRules?.providerRules || [];
  const rule = baseUrl
    ? rules.find((r) => normalizeBaseUrl(r?.config?.api?.baseUrl) === normalizeBaseUrl(baseUrl)) ||
      rules.find((r) => r?.providerId === ZCODE_PROVIDER_ID)
    : rules.find((r) => r?.providerId === ZCODE_PROVIDER_ID);
  const providerId = rule?.providerId || "";
  const models = (data?.config?.modelConfigRules?.providerModelRules || []).filter(
    (r) => r?.providerId === providerId,
  );
  return {
    installed: zcodeInstalled(),
    path: file,
    applied: Boolean(rule),
    providerId,
    baseUrl: rule?.config?.api?.baseUrl || "",
    protocol: rule?.config?.api?.type || "",
    modelCount: models.length,
    models: models.map((r) => ({
      id: r.modelId,
      contextWindow: r.config?.properties?.contextWindow || null,
    })),
  };
}
