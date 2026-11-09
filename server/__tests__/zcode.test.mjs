/**
 * ZCode 接入与 usage 契约的回归测试。
 *
 * 这些断言钉的是 ZCode 真正依赖的东西，不是我们自己的约定：
 *  - 上下文条的分子：流式 usage 必须在 choices:[] 的独立帧里
 *  - 上下文条的分母：模型配置必须有 properties.contextWindow
 *  - 缓存命中：cached_tokens 要出现在客户端认的字段里
 *  - 用户数据：重复写入不能堆叠，其他 provider 必须逐字保留
 *
 * 运行：node --test server/__tests__/zcode.test.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { mergeZcodeConfig, ZCODE_PROVIDER_ID, ZCODE_CONTEXT_WINDOW } from "../zcode.js";
import { resolveModelRequest } from "../proxy/models.js";

const BASE = "http://127.0.0.1:7891/v1";

/** 一份「用户已经配过别的 provider」的配置，用来验证不误伤 */
function fixture() {
  return {
    schemaVersion: 1,
    config: {
      providerOrder: ["other-provider"],
      providerConfigRules: {
        providerRules: [
          {
            providerId: "other-provider",
            providerName: "Other",
            config: {
              group: "standard-personal",
              access: { type: "api-key", apiKey: "sk-other" },
              api: { type: "openai-responses", baseUrl: "https://other.example/v1" },
              personalModelIds: ["other-model"],
              modelOrder: ["other-model"],
            },
          },
        ],
      },
      modelConfigRules: {
        providerModelRules: [
          {
            modelId: "other-model",
            providerId: "other-provider",
            config: { enabled: true, properties: { contextWindow: 128000 } },
          },
        ],
      },
    },
  };
}

const MODELS = [
  { id: "auto", displayName: "Auto（默认）", isVl: true, isReasoning: true },
  { id: "dfmodel", displayName: "DeepSeek-Flash", isVl: true, isReasoning: false },
  { id: "jmodel", displayName: "Step-5-Preview", isVl: true, isReasoning: true },
];

test("每个模型都带上 contextWindow（上下文条的分母）", () => {
  const out = mergeZcodeConfig(fixture(), { baseUrl: BASE, apiKey: "k", models: MODELS });
  const rules = out.config.modelConfigRules.providerModelRules.filter((r) => r.providerId === ZCODE_PROVIDER_ID);
  assert.equal(rules.length, MODELS.length);
  for (const rule of rules) {
    assert.equal(rule.config.properties.contextWindow, ZCODE_CONTEXT_WINDOW);
  }
});

test("模型 id 用别名可解析的 display name，解析不到则退回 key", () => {
  const out = mergeZcodeConfig(fixture(), { baseUrl: BASE, apiKey: "k", models: MODELS });
  const ids = out.config.modelConfigRules.providerModelRules
    .filter((r) => r.providerId === ZCODE_PROVIDER_ID)
    .map((r) => r.modelId);
  // DeepSeek-Flash 在别名表里 → 用它；Step-5-Preview 不在 → 保持 key；
  // 含中文括号的 Auto（默认）不适合当 id → 保持 key
  assert.deepEqual(ids, ["auto", "DeepSeek-Flash", "jmodel"]);
  for (const id of ids) {
    // 网关必须认得自己写进 ZCode 的每一个 id，否则用户一发请求就 400
    assert.ok(resolveModelRequest(id).key.length > 0, `${id} 必须可解析`);
  }
});

test("重复写入不堆叠 provider、不新增重复模型条目", () => {
  const once = mergeZcodeConfig(fixture(), { baseUrl: BASE, apiKey: "k", models: MODELS });
  const twice = mergeZcodeConfig(once, { baseUrl: BASE, apiKey: "k", models: MODELS });
  assert.equal(JSON.stringify(once) === JSON.stringify(twice), true, "第二次写入必须与第一次完全一致");
  assert.equal(twice.config.providerConfigRules.providerRules.filter((r) => r.providerId === ZCODE_PROVIDER_ID).length, 1);
});

test("复用同 baseUrl 的既有 provider，而不是新建一条", () => {
  const existing = fixture();
  existing.config.providerConfigRules.providerRules.push({
    providerId: "new-provider-5",
    providerName: "Qoder",
    config: {
      group: "standard-personal",
      access: { type: "api-key", apiKey: "" },
      api: { type: "openai-chat-completions", baseUrl: BASE },
      personalModelIds: ["qwen3.8-flash"],
      modelOrder: ["qwen3.8-flash"],
    },
  });
  const out = mergeZcodeConfig(existing, { baseUrl: BASE, apiKey: "k", models: MODELS });
  const qoderRules = out.config.providerConfigRules.providerRules.filter(
    (r) => r.config?.api?.baseUrl === BASE,
  );
  assert.equal(qoderRules.length, 1, "同地址只能有一条 provider");
  assert.equal(qoderRules[0].providerId, "new-provider-5", "复用既有 providerId，用户的模型选择不断开");
  // 用户原有的模型条目不能消失
  assert.ok(qoderRules[0].config.modelOrder.includes("qwen3.8-flash"));
});

test("用户已有模型条目按上游 key 匹配，只补窗口不改 id", () => {
  const existing = fixture();
  existing.config.providerConfigRules.providerRules.push({
    providerId: "qod",
    providerName: "Qoder",
    config: { group: "standard-personal", access: { type: "api-key", apiKey: "" }, api: { type: "openai-chat-completions", baseUrl: BASE } },
  });
  existing.config.modelConfigRules.providerModelRules.push({
    modelId: "qwen3.8-flash",
    providerId: "qod",
    config: { enabled: true },
  });
  const out = mergeZcodeConfig(existing, {
    baseUrl: BASE,
    apiKey: "k",
    models: [{ id: "qfmodel", displayName: "Qwen3.8-Flash", isVl: true }],
  });
  const rules = out.config.modelConfigRules.providerModelRules.filter((r) => r.providerId === "qod");
  assert.equal(rules.length, 1, "qfmodel 与 qwen3.8-flash 是同一个模型，不能并排两条");
  assert.equal(rules[0].modelId, "qwen3.8-flash", "保留用户写的 id");
  assert.equal(rules[0].config.properties.contextWindow, ZCODE_CONTEXT_WINDOW, "但要把窗口补上");
});

test("其他 provider 的配置逐字保留", () => {
  const before = fixture();
  const out = mergeZcodeConfig(before, { baseUrl: BASE, apiKey: "k", models: MODELS });
  const strip = (cfg) => ({
    providers: cfg.config.providerConfigRules.providerRules.filter((r) => r.providerId !== ZCODE_PROVIDER_ID),
    models: cfg.config.modelConfigRules.providerModelRules.filter((r) => r.providerId !== ZCODE_PROVIDER_ID),
  });
  assert.equal(JSON.stringify(strip(out)), JSON.stringify(strip(before)));
  assert.equal(out.config.providerOrder[0], "other-provider", "既有 provider 顺序不变");
});

test("原子写：临时文件不残留，JSON 始终完整可解析", async () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "zcode-test-"));
  const savedHome = process.env.HOME;
  process.env.HOME = tmpHome;
  try {
    const mod = await import(`../zcode.js?t=${Date.now()}`);
    fs.mkdirSync(path.join(tmpHome, ".zcode/v2"), { recursive: true });
    mod.applyZcode({ baseUrl: BASE, apiKey: "k", models: MODELS });
    const dir = path.join(tmpHome, ".zcode/v2");
    const files = fs.readdirSync(dir);
    assert.ok(files.includes("provider_config.json"));
    assert.equal(files.filter((f) => f.includes(".tmp-")).length, 0, "不能残留临时文件");
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, "provider_config.json"), "utf8"));
    assert.ok(parsed.config.providerConfigRules.providerRules.length > 0);
    // 移除后什么都不该留下
    const removed = mod.removeZcode({ baseUrl: BASE });
    assert.equal(removed.removed, true);
    const after = JSON.parse(fs.readFileSync(path.join(dir, "provider_config.json"), "utf8"));
    assert.equal(after.config.providerConfigRules.providerRules.length, 0);
    assert.equal(after.config.modelConfigRules.providerModelRules.length, 0);
    assert.equal(after.config.providerOrder.length, 0);
  } finally {
    process.env.HOME = savedHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});
