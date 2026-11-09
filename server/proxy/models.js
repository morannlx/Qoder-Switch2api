/**
 * 模型别名解析：客户端经常发送 display name（如 DeepSeek-Flash）或带 effort 后缀，
 * 上游真正需要的是 model key（如 dfmodel）。这里做统一映射，避免 400。
 */
const KEYS = new Set([
  "auto", "lite",
  "qmodel_38max", "qfmodel", "qmodel_latest", "qmodel", "q37fmodel",
  "dmodel", "dfmodel", "gmodel", "gfmodel", "gm51model",
  "kmodel_latest", "kmodel", "mmodel",
]);

const ALIASES = new Map(Object.entries({
  auto: "auto",
  lite: "lite",
  "qwen3.8-max": "qmodel_38max",
  "qwen-3.8-max": "qmodel_38max",
  "qwen38max": "qmodel_38max",
  "qwen3.8-flash": "qfmodel",
  "qwen-3.8-flash": "qfmodel",
  "qwen3.7-max": "qmodel_latest",
  "qwen-3.7-max": "qmodel_latest",
  "qwen3.7-plus": "qmodel",
  "qwen-3.7-plus": "qmodel",
  "qwen3.7-flash": "q37fmodel",
  "qwen-3.7-flash": "q37fmodel",
  "deepseek-v4-pro": "dmodel",
  "deepseek-4-pro": "dmodel",
  "deepseek-v4": "dmodel",
  "deepseek-pro": "dmodel",
  "deepseek-flash": "dfmodel",
  "deepseek-chat": "dfmodel",
  "deepseek-v3": "dfmodel",
  "glm-5.3": "gmodel",
  "glm5.3": "gmodel",
  "glm-5.3-flash": "gfmodel",
  "glm5.3-flash": "gfmodel",
  "glm-5.2": "gm51model",
  "glm5.2": "gm51model",
  "kimi-k3": "kmodel_latest",
  "kimi-k2.8-preview": "kmodel",
  "kimi-k2.8": "kmodel",
  "minimax-m3.1-flash": "mmodel",
  "minimax": "mmodel",
}));

function normalizeAlias(raw) {
  return raw
    .trim()
    .toLowerCase()
    .replace(/^qoder[\/:_\s-]+/, "")
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9.-]/g, "");
}

function lookup(raw) {
  const lower = raw.trim().toLowerCase();
  if (KEYS.has(lower)) return lower;
  return ALIASES.get(normalizeAlias(raw)) || "";
}

/**
 * 返回 { key, effort }。
 * 只有去掉 effort 后缀后能识别出基础模型时才剥离，避免把 Qwen3.8-Max 的 Max 当 effort。
 */
export function resolveModelRequest(raw) {
  const value = String(raw || "").trim() || "auto";
  const direct = lookup(value);
  if (direct) return { key: direct, effort: "" };
  const match = /^(.*?)[\s_-]+(xhigh|high|medium|low|max)$/i.exec(value);
  if (match) {
    const base = lookup(match[1]);
    if (base) {
      const effort = match[2].toLowerCase();
      return { key: base, effort: effort === "xhigh" ? "xhigh" : effort };
    }
  }
  return { key: value, effort: "" };
}

/**
 * 反代对外宣告的模型目录（/v1/models 与 ZCode 接入共用同一份）。
 *
 * 两边必须一致：ZCode 的 provider 模型清单与每个模型的上下文窗口都按这里
 * 写进 provider_config.json，而 /v1/models 是别的客户端（Codex、Cherry
 * Studio）读的同一份事实。任何一侧单独变动都会让上下文条与实际窗口不一致。
 *
 * @param {object} edition 档位定义
 * @param {object} config  该档位的反代配置（extraModels / apiKey 等）
 * @param {object} opts    { pickAccount, fetchModelList, defaults }
 */
export async function modelCatalogForProxy(edition, config, opts = {}) {
  const defaults = opts.defaults || [
    { id: "auto", displayName: "Auto（默认）", isReasoning: true, isVl: true },
    { id: "lite", displayName: "Lite", isReasoning: true, isVl: true },
  ];
  const models = defaults.map((m) => ({ ...m }));
  const account = opts.pickAccount?.(edition.value);
  if (account && opts.fetchModelList) {
    try {
      const upstream = await opts.fetchModelList(edition, account);
      for (const m of upstream) {
        if (!models.some((x) => x.id === m.id)) models.push(m);
      }
    } catch {
      /* 上游不可达时只用默认列表 */
    }
  }
  for (const id of config?.extraModels || []) {
    if (id && !models.some((x) => x.id === id)) models.push({ id, displayName: id, extra: true });
  }
  return models;
}
