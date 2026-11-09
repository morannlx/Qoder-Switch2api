#!/usr/bin/env node
/**
 * 命令行接入 ZCode：等价于反代页的「接入 ZCode」按钮，供 ZCode 退出后
 * 在终端里执行（ZCode 运行时会重写 provider_config.json，必须先退出）。
 *
 * 用法：
 *   node scripts/zcode-apply.mjs            # 接入国内市场（默认 7891）
 *   node scripts/zcode-apply.mjs international
 *   node scripts/zcode-apply.mjs --remove   # 从 ZCode 配置移除
 *   node scripts/zcode-apply.mjs --check    # 只看现状，不写
 *
 * 走的是本机 API（默认 http://127.0.0.1:8787），所以 WebUI 服务要在运行。
 */
const API = process.env.QODER_SWITCH_API || "http://127.0.0.1:8787";
const args = process.argv.slice(2);
const remove = args.includes("--remove");
const check = args.includes("--check");
const edition = args.includes("international") ? "international" : "domestic";

async function call(path, init) {
  const resp = await fetch(API + path, init);
  const text = await resp.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* 非 JSON 响应 */
  }
  if (!resp.ok) {
    const message = json?.error || text || `HTTP ${resp.status}`;
    throw new Error(message);
  }
  return json;
}

function describe(status) {
  console.log("配置文件     :", status.path);
  console.log("已接入       :", status.applied ? `是（provider ${status.providerId}）` : "否");
  console.log("配置里的地址 :", status.baseUrl || "—");
  console.log("反代实际地址 :", status.wantedBaseUrl);
  if (status.models?.length) {
    console.log("模型与窗口   :");
    for (const m of status.models) {
      console.log("  -", m.id.padEnd(22), m.contextWindow ? `${m.contextWindow} tokens` : "（未声明，ZCode 会按默认 2e5 显示）");
    }
  }
}

try {
  const status = await call(`/api/zcode/status?edition=${edition}`);
  if (!status.installed) {
    console.log("这台机器上没有找到 ZCode（~/.zcode 不存在），无需接入。");
    process.exit(0);
  }
  if (check) {
    describe(status);
    process.exit(0);
  }
  if (remove) {
    const res = await call("/api/zcode/remove", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ edition }),
    });
    console.log(res.removed ? `已从 ZCode 配置移除（provider ${res.providerId || "—"}）` : "ZCode 配置里没有本网关，无需移除");
    process.exit(0);
  }
  const res = await call("/api/zcode/apply", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ edition }),
  });
  console.log(`已写入 ${res.path}`);
  console.log(`provider ${res.providerId}，${res.models} 个模型（含上下文窗口）`);
  console.log("现在可以启动 ZCode 了。");
  describe(await call(`/api/zcode/status?edition=${edition}`));
} catch (e) {
  console.error("失败：" + String(e.message || e));
  process.exit(1);
}
