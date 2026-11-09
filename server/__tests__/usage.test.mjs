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

test("按天汇总覆盖各窗口，总消耗等于终身累计", async () => {
  await withTempHome(async ({ mod }) => {
    const now = Date.now();
    // 1 天前、5 天前、10 天前、20 天前、100 天前各一条，每条 15 tokens
    for (const daysAgo of [1, 5, 10, 20, 100]) {
      mod.recordUsage({ ...record(), ts: now - daysAgo * DAY });
    }
    const s = mod.usageStats();
    // heatmap 只含有数据的日子，按日期窗口过滤（不是按条数切片）
    const within = (n) => {
      const cutoff = new Date();
      cutoff.setHours(0, 0, 0, 0);
      cutoff.setDate(cutoff.getDate() - (n - 1));
      const key = `${cutoff.getFullYear()}-${String(cutoff.getMonth() + 1).padStart(2, "0")}-${String(cutoff.getDate()).padStart(2, "0")}`;
      return s.heatmap.filter((d) => d.day >= key);
    };
    assert.equal(within(7).reduce((a, d) => a + d.requests, 0), 2, "7 日窗口应含 1/5 天前两条");
    assert.equal(within(15).reduce((a, d) => a + d.requests, 0), 3, "15 日窗口再加 10 天前那条");
    assert.equal(within(30).reduce((a, d) => a + d.requests, 0), 4, "30 日窗口含 1/5/10/20 天前共 4 条");
    assert.equal(s.heatmap.length, 5, "含 100 天前那条");
    assert.equal(s.totals.requests, 5);
    assert.equal(s.totals.totalTokens, 75);
    assert.equal(s.activity.totalTokens, s.totals.totalTokens, "activity 与 totals 同源");
  });
});

test("今日的请求立即计入按天汇总", async () => {
  await withTempHome(async ({ mod }) => {
    mod.recordUsage(record({ totalTokens: 100 }));
    const s = mod.usageStats();
    const today = s.heatmap[s.heatmap.length - 1];
    assert.equal(today.tokens, 100, "今天应在热力图末尾且带 token 数");
    assert.equal(s.daily.length, 1);
    assert.equal(s.daily[0].totalTokens, 100);
  });
});

test("明细被裁剪后，总消耗与按天汇总不回退", async () => {
  await withTempHome(async ({ mod }) => {
    const now = Date.now();
    // 一条 200 天前的，会被后续写入挤出明细窗口
    mod.recordUsage({ ...record({ totalTokens: 1500 }), ts: now - 200 * DAY });
    const baseline = mod.usageStats();
    assert.equal(baseline.totals.totalTokens, 1500);
    assert.equal(baseline.heatmap.length, 1, "200 天前那条在热力图里");

    // 灌满并超过 MAX_RECORDS，把那条挤掉
    for (let i = 0; i < 5100; i += 1) mod.recordUsage(record({ totalTokens: 2 }));

    const after = mod.usageStats();
    assert.equal(after.totals.totalTokens, 1500 + 5100 * 2, "总消耗必须只增不减");
    assert.equal(
      after.heatmap.length,
      2,
      "按天汇总同时保留 200 天前与今天两个日子",
    );
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
    assert.equal(first.totals.totalTokens, 15, "首次读取应回填 rollup");
    const written = JSON.parse(fs.readFileSync(path.join(dir, "usage.json"), "utf8"));
    assert.ok(written.rollup, "回填后应落盘 rollup");

    const second = mod.usageStats();
    assert.equal(second.totals.totalTokens, 15, "二次读取不能重复累加");
    assert.equal(second.totals.requests, 1);
    void tmp;
  });
});

test("按档位过滤：各版本统计互不串台", async () => {
  await withTempHome(async ({ mod }) => {
    mod.recordUsage(record({ edition: "domestic", totalTokens: 100 }));
    mod.recordUsage(record({ edition: "international", totalTokens: 7 }));

    const all = mod.usageStats();
    assert.equal(all.totals.totalTokens, 107);

    const domestic = mod.usageStats("domestic");
    assert.equal(domestic.totals.totalTokens, 100);
    assert.equal(domestic.heatmap.reduce((a, d) => a + d.tokens, 0), 100);

    const intl = mod.usageStats("international");
    assert.equal(intl.totals.totalTokens, 7);
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
    assert.equal(s.totals.errors, 1);
    assert.equal(s.totals.requests, 2);
    assert.equal(s.totals.totalTokens, 20);
  });
});

/* ---------------- 活动概览 / 热力图 / 模型趋势 ---------------- */

test("活动概览：活跃天数、峰值单日、连续天数都来自按天汇总", async () => {
  await withTempHome(async ({ mod }) => {
    const now = new Date();
    const dayOffset = (n) => new Date(now.getFullYear(), now.getMonth(), now.getDate() - n, 12).getTime();
    // 今天、昨天、前天连续三天；外加 10 天前单飞一天
    mod.recordUsage({ ...record({ totalTokens: 10 }), ts: dayOffset(0) });
    mod.recordUsage({ ...record({ totalTokens: 20 }), ts: dayOffset(1) });
    mod.recordUsage({ ...record({ totalTokens: 30 }), ts: dayOffset(2) });
    mod.recordUsage({ ...record({ totalTokens: 500 }), ts: dayOffset(10) });

    const s = mod.usageStats();
    assert.equal(s.activity.activeDays, 4, "四个有活动的日子");
    assert.equal(s.activity.peakTokens, 500, "峰值来自 10 天前那条");
    assert.equal(s.activity.longestStreak, 3, "今天起连续三天");
    assert.equal(s.activity.currentStreak, 3);
    assert.equal(s.activity.totalTokens, 560);
    // 热力图只含有数据的日子
    assert.equal(s.heatmap.length, 4);
    assert.deepEqual(
      s.heatmap.map((d) => d.tokens),
      [500, 30, 20, 10],
      "热力图按日期升序",
    );
  });
});

test("今天还没有请求时，当前连续数不清零（从昨天起算）", async () => {
  await withTempHome(async ({ mod }) => {
    const now = new Date();
    const y = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 12).getTime();
    const d2 = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 2, 12).getTime();
    mod.recordUsage({ ...record(), ts: y });
    mod.recordUsage({ ...record(), ts: d2 });
    const s = mod.usageStats();
    assert.equal(s.activity.currentStreak, 2, "昨天 + 前天连续，今天没用也算连续中");
  });
});

test("断档后的当前连续只算最近这一段", async () => {
  await withTempHome(async ({ mod }) => {
    const now = new Date();
    const off = (n) => new Date(now.getFullYear(), now.getMonth(), now.getDate() - n, 12).getTime();
    // 今天、昨天；再往前隔了两天
    mod.recordUsage({ ...record(), ts: off(0) });
    mod.recordUsage({ ...record(), ts: off(1) });
    mod.recordUsage({ ...record(), ts: off(4) });
    mod.recordUsage({ ...record(), ts: off(5) });
    const s = mod.usageStats();
    assert.equal(s.activity.currentStreak, 2, "当前连续只看今天/昨天");
    assert.equal(s.activity.longestStreak, 2);
  });
});

test("模型趋势：同名不同拼写合并成一条线，未用的日子为 null", async () => {
  await withTempHome(async ({ mod }) => {
    const now = new Date();
    const off = (n) => new Date(now.getFullYear(), now.getMonth(), now.getDate() - n, 12).getTime();
    // 同一个模型三种拼写，应该合并
    mod.recordUsage({ ...record({ model: "deepseek-flash", totalTokens: 100 }), ts: off(0) });
    mod.recordUsage({ ...record({ model: "DeepSeek-Flash", totalTokens: 50 }), ts: off(0) });
    mod.recordUsage({ ...record({ model: "dfmodel", totalTokens: 70 }), ts: off(2) });

    const s = mod.usageStats();
    assert.equal(s.modelDaily.series.length, 1, "三种拼写应归并为一个模型");
    const series = s.modelDaily.series[0];
    assert.equal(series.name, "dfmodel", "归并键是上游 key");
    assert.equal(series.label, "DeepSeek-Flash", "展示名可读");
    assert.equal(series.values.length, s.modelDaily.days.length, "values 与 days 对齐");
    const last = series.values.length - 1;
    assert.equal(series.values[last], 150, "今天两条相加");
    assert.equal(series.values[last - 1], null, "昨天没请求 = null（折线断开）");
    assert.equal(series.values[last - 2], 70, "前天那条");
  });
});

test("模型趋势最多给 6 条，按窗口内总量降序", async () => {
  await withTempHome(async ({ mod }) => {
    for (let i = 0; i < 9; i += 1) {
      mod.recordUsage(record({ model: `model-${i}`, totalTokens: (i + 1) * 10 }));
    }
    const s = mod.usageStats();
    assert.equal(s.modelDaily.series.length, 6, "只留前 6 个模型");
    assert.equal(s.modelDaily.series[0].name, "model-8", "总量最高的排第一");
    const totals = s.modelDaily.series.map((x) => x.values.reduce((a, b) => (a || 0) + (b || 0), 0));
    assert.deepEqual(totals, [...totals].sort((a, b) => b - a), "按总量降序");
  });
});

test("按模型分布按上游 key 归并，并带 label", async () => {
  await withTempHome(async ({ mod }) => {
    mod.recordUsage(record({ model: "deepseek-flash", totalTokens: 100 }));
    mod.recordUsage(record({ model: "DeepSeek-Flash", totalTokens: 50 }));
    const s = mod.usageStats();
    assert.equal(s.byModel.length, 1, "两种拼写合并为一行");
    assert.equal(s.byModel[0].name, "dfmodel");
    assert.equal(s.byModel[0].label, "DeepSeek-Flash");
    assert.equal(s.byModel[0].totalTokens, 150);
  });
});

test("老文件没有 byModelDay 时按明细回填，且只回填趋势窗口内的日子", async () => {
  await withTempHome(async ({ dir }) => {
    const now = new Date();
    const off = (n) => new Date(now.getFullYear(), now.getMonth(), now.getDate() - n, 12).getTime();
    const mk = (ts, tokens) => ({
      ts, edition: "domestic", accountId: "a", accountName: "acc", model: "deepseek-flash",
      promptTokens: tokens, completionTokens: 0, totalTokens: tokens, durationMs: 1,
      success: true, error: "", api: "chat",
    });
    // v1.1.32 的 rollup：有 byDay / lifetime，但没有 byModelDay
    const legacy = {
      records: [mk(off(1), 100), mk(off(100), 999)],
      rollup: {
        byDay: { domestic: { [dayOf(off(1))]: { requests: 1, promptTokens: 100, completionTokens: 0, totalTokens: 100, errors: 0 } } },
        lifetime: { domestic: { requests: 2, promptTokens: 1099, completionTokens: 0, totalTokens: 1099, errors: 0 } },
      },
    };
    fs.writeFileSync(path.join(dir, "usage.json"), JSON.stringify(legacy));

    const mod = await import(`../proxy/usage.js?t=${Date.now()}-${Math.random()}`);
    const s = mod.usageStats();
    assert.ok(s.modelDaily.series.length >= 1, "回填后趋势可用");
    const all = s.modelDaily.series[0].values.reduce((a, b) => (a || 0) + (b || 0), 0);
    assert.equal(all, 100, "100 天前那条超出趋势窗口，不该回填进来");
    assert.equal(s.totals.totalTokens, 1099, "终身累计照旧，不受回填影响");

    // 二次读取不重复累加
    const again = mod.usageStats();
    const all2 = again.modelDaily.series[0].values.reduce((a, b) => (a || 0) + (b || 0), 0);
    assert.equal(all2, 100, "回填必须幂等");
  });
});

/** 本地日期键，测试里构造 rollup 用 */
function dayOf(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

test("模型趋势的日期范围只覆盖有数据的那一段（不满 30 天也给满不拉伸）", async () => {
  await withTempHome(async ({ mod }) => {
    const now = new Date();
    const off = (n) => new Date(now.getFullYear(), now.getMonth(), now.getDate() - n, 12).getTime();
    // 只有最近 3 天有数据
    mod.recordUsage({ ...record({ totalTokens: 10 }), ts: off(2) });
    mod.recordUsage({ ...record({ totalTokens: 20 }), ts: off(1) });
    mod.recordUsage({ ...record({ totalTokens: 30 }), ts: off(0) });

    const s = mod.usageStats();
    assert.equal(s.modelDaily.days.length, 3, "只覆盖有数据的 3 天，不是固定 30 天");
    assert.equal(s.modelDaily.series[0].values.length, 3, "values 与缩短后的 days 对齐");
    assert.deepEqual(s.modelDaily.series[0].values, [10, 20, 30]);
  });
});

test("模型趋势在有数据的日子之间保留空档（折线断开）", async () => {
  await withTempHome(async ({ mod }) => {
    const now = new Date();
    const off = (n) => new Date(now.getFullYear(), now.getMonth(), now.getDate() - n, 12).getTime();
    mod.recordUsage({ ...record({ totalTokens: 10 }), ts: off(4) });
    mod.recordUsage({ ...record({ totalTokens: 30 }), ts: off(0) });

    const s = mod.usageStats();
    assert.equal(s.modelDaily.days.length, 5, "首尾之间补齐日期");
    assert.deepEqual(s.modelDaily.series[0].values, [10, null, null, null, 30]);
  });
});
