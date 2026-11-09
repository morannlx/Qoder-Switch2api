/**
 * 用量窗口统计的回归测试。
 *
 * 钉住两个容易写错的地方：
 *  1. 窗口（今日 / 7 / 15 / 30 日）与总消耗**不能**从明细算 —— 明细只留 5000 条，
 *     一旦跑满，早期记录被裁掉，窗口数字会一天天变小、总消耗永远算不对。
 *  2. 迁移必须幂等：老文件（只有 records）第一次读要能回填 rollup，
 *     之后再读不能重复累加。
 *
 * 运行：node --test server/__tests__/usage.test.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

/** 每个测试用独立的 HOME，模块要重新导入才能读到新的数据目录 */
async function withTempHome(fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "usage-test-"));
  const saved = process.env.HOME;
  process.env.HOME = tmp;
  fs.mkdirSync(path.join(tmp, ".qoder-switch"), { recursive: true });
  try {
    const mod = await import(`../proxy/usage.js?t=${Date.now()}-${Math.random()}`);
    await fn({ mod, dir: path.join(tmp, ".qoder-switch"), tmp });
  } finally {
    process.env.HOME = saved;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

const DAY = 86_400_000;

function record(overrides = {}) {
  return {
    edition: "domestic",
    accountName: "acc",
    model: "m",
    promptTokens: 10,
    completionTokens: 5,
    totalTokens: 15,
    success: true,
    api: "chat",
    ...overrides,
  };
}

test("今日 / 7 / 15 / 30 日窗口互相包含，总消耗等于终身累计", async () => {
  await withTempHome(async ({ mod }) => {
    const now = Date.now();
    // 1 天前、5 天前、10 天前、20 天前、100 天前各一条，每条 15 tokens
    for (const daysAgo of [1, 5, 10, 20, 100]) {
      mod.recordUsage({ ...record(), ts: now - daysAgo * DAY });
    }
    const s = mod.usageStats();
    assert.equal(s.windows.today.totalTokens, 0, "今天还没请求");
    // 7 日窗口含 1 天前与 5 天前两条
    assert.equal(s.windows.d7.requests, 2);
    assert.equal(s.windows.d7.totalTokens, 30);
    assert.equal(s.windows.d15.requests, 3, "再加 10 天前那条");
    assert.equal(s.windows.d30.requests, 4, "1/5/10/20 天前共 4 条");
    assert.equal(s.windows.all.requests, 5, "含 100 天前那条");
    assert.equal(s.windows.all.totalTokens, 75);
    assert.equal(s.totals.totalTokens, s.windows.all.totalTokens, "totals 必须等于总消耗");
  });
});

test("窗口口径：今日含此刻，今天是 d1 的最后一天", async () => {
  await withTempHome(async ({ mod }) => {
    mod.recordUsage(record({ totalTokens: 100 }));
    const s = mod.usageStats();
    assert.equal(s.windows.today.totalTokens, 100);
    assert.equal(s.windows.d7.totalTokens, 100);
    assert.equal(s.windows.d30.totalTokens, 100);
    assert.ok(s.windows.d7.requests >= s.windows.today.requests);
  });
});

test("明细被裁剪后，总消耗与窗口不回退", async () => {
  await withTempHome(async ({ mod }) => {
    const now = Date.now();
    // 一条 200 天前的，会被后续写入挤出明细窗口
    mod.recordUsage({ ...record({ totalTokens: 1500 }), ts: now - 200 * DAY });
    const baseline = mod.usageStats();
    assert.equal(baseline.windows.all.totalTokens, 1500);
    assert.equal(baseline.windows.d30.totalTokens, 0, "200 天前不在 30 天窗口内");

    // 灌满并超过 MAX_RECORDS，把那条挤掉
    for (let i = 0; i < 5100; i += 1) mod.recordUsage(record({ totalTokens: 2 }));

    const after = mod.usageStats();
    assert.equal(after.windows.all.totalTokens, 1500 + 5100 * 2, "总消耗必须只增不减");
    assert.equal(after.windows.d30.totalTokens, 5100 * 2);
    assert.equal(after.detailCount, 5000, "明细确实被裁剪到上限");
    // 老记录已不在明细里，但总量仍在
    assert.equal(
      after.recent.some((r) => r.totalTokens === 1500),
      false,
      "老记录应已被挤出明细",
    );
  });
});

test("迁移幂等：老文件回填一次，重复读取不重复累加", async () => {
  await withTempHome(async ({ dir, tmp }) => {
    const now = Date.now();
    const legacy = {
      records: [
        { ts: now, edition: "domestic", accountId: "a", accountName: "acc", model: "m", promptTokens: 10, completionTokens: 5, totalTokens: 15, durationMs: 1, success: true, error: "", api: "chat" },
      ],
      totals: { requests: 1, promptTokens: 10, completionTokens: 5, totalTokens: 15, errors: 0 },
    };
    fs.writeFileSync(path.join(dir, "usage.json"), JSON.stringify(legacy));

    const mod = await import(`../proxy/usage.js?t=${Date.now()}-${Math.random()}`);
    const first = mod.usageStats();
    assert.equal(first.windows.all.totalTokens, 15, "首次读取应回填 rollup");
    const written = JSON.parse(fs.readFileSync(path.join(dir, "usage.json"), "utf8"));
    assert.ok(written.rollup, "回填后应落盘 rollup");

    const second = mod.usageStats();
    assert.equal(second.windows.all.totalTokens, 15, "二次读取不能重复累加");
    assert.equal(second.windows.all.requests, 1);
    void tmp;
  });
});

test("按档位过滤：各版本窗口互不串台", async () => {
  await withTempHome(async ({ mod }) => {
    mod.recordUsage(record({ edition: "domestic", totalTokens: 100 }));
    mod.recordUsage(record({ edition: "international", totalTokens: 7 }));

    const all = mod.usageStats();
    assert.equal(all.windows.all.totalTokens, 107);

    const domestic = mod.usageStats("domestic");
    assert.equal(domestic.windows.all.totalTokens, 100);
    assert.equal(domestic.windows.today.totalTokens, 100);

    const intl = mod.usageStats("international");
    assert.equal(intl.windows.all.totalTokens, 7);
  });
});

test("每日趋势覆盖 30 天内所有有数据的日子，跨月也连续", async () => {
  await withTempHome(async ({ mod }) => {
    const now = new Date();
    const days = [];
    for (let i = 0; i < 3; i += 1) {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i, 12, 0, 0);
      days.push(d.getTime());
      mod.recordUsage({ ...record({ totalTokens: 10 }), ts: d.getTime() });
    }
    const s = mod.usageStats();
    assert.equal(s.daily.length, 3, "三天都有数据，趋势应有 3 个点");
    // 从早到晚
    assert.deepEqual(
      s.daily.map((d) => d.day),
      [...s.daily.map((d) => d.day)].sort(),
    );
    assert.equal(
      s.daily.reduce((sum, d) => sum + d.totalTokens, 0),
      30,
    );
  });
});

test("失败请求计入 errors，但不污染 token 统计", async () => {
  await withTempHome(async ({ mod }) => {
    mod.recordUsage(record({ success: false, totalTokens: 0, promptTokens: 0, completionTokens: 0 }));
    mod.recordUsage(record({ totalTokens: 20 }));
    const s = mod.usageStats();
    assert.equal(s.windows.all.errors, 1);
    assert.equal(s.windows.all.requests, 2);
    assert.equal(s.windows.all.totalTokens, 20);
  });
});
