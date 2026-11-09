/**
 * 反代用量统计：请求数、Token 消耗，按账号 / 模型 / 日期聚合。
 * 落盘 ~/.qoder-switch/usage.json。
 *
 * 两套数据，用途不同，不能互相替代：
 *  - records：最近 5000 条明细，只用来画「按账号 / 模型 / API 分布」与最近请求列表。
 *  - rollup：按天累计的汇总（每档位一份）+ 终身累计。**窗口统计与总消耗只认它**——
 *    明细是按条截断的，一旦跑满 5000 条，早期记录会被裁掉；若用明细算「近 30 天」，
 *    数字会随着裁剪一天天变小，「总消耗」更是永远算不对。
 */
import { loadJson, saveJson } from "../store.js";
import { modelStatsKey } from "./models.js";

const MAX_RECORDS = 5000;
/** 按天汇总保留天数：只影响窗口统计能回溯多久，不影响「总消耗」（终身累计单独记） */
const MAX_DAILY_DAYS = 400;
/** 按模型趋势保留天数：趋势图最多看 30 天，多留几天余量 */
const MODEL_TREND_DAYS = 35;
/** 热力图回溯天数（参考 GitHub 的一年视图，但只画有数据的日子） */
const HEATMAP_DAYS = 365;

function emptyBucket() {
  return { requests: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, errors: 0 };
}

function emptyState() {
  return { records: [], totals: emptyBucket(), rollup: emptyRollup() };
}

function emptyRollup() {
  return { byDay: {}, lifetime: {}, byModelDay: {} };
}

function addToBucket(bucket, r) {
  bucket.requests += 1;
  bucket.promptTokens += r.promptTokens || 0;
  bucket.completionTokens += r.completionTokens || 0;
  bucket.totalTokens += r.totalTokens || 0;
  if (!r.success) bucket.errors += 1;
  return bucket;
}

function mergeBuckets(into, from) {
  into.requests += from.requests || 0;
  into.promptTokens += from.promptTokens || 0;
  into.completionTokens += from.completionTokens || 0;
  into.totalTokens += from.totalTokens || 0;
  into.errors += from.errors || 0;
  return into;
}

function dayKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** 最近 n 天（含今天）的本地日期键，从早到晚 */
function recentDayKeys(n) {
  const now = new Date();
  const out = [];
  for (let i = n - 1; i >= 0; i -= 1) {
    // 用构造函数做日期回退，自动处理跨月与夏令时
    out.push(dayKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - i).getTime()));
  }
  return out;
}

function editionKey(edition) {
  return edition || "unknown";
}

/**
 * 把一条记录计入按天汇总与终身累计。
 * 终身累计只增不减：它是「总消耗」的唯一来源，不能从会被裁剪的明细重算。
 */
function applyRollup(rollup, r) {
  const key = dayKey(r.ts);
  const edition = editionKey(r.edition);
  if (!rollup.byDay[edition]) rollup.byDay[edition] = {};
  if (!rollup.byDay[edition][key]) rollup.byDay[edition][key] = emptyBucket();
  addToBucket(rollup.byDay[edition][key], r);
  if (!rollup.lifetime[edition]) rollup.lifetime[edition] = emptyBucket();
  addToBucket(rollup.lifetime[edition], r);
  // 按模型 × 天的趋势：只留近 35 天（趋势图最多看 30 天），
  // 不跟着 MAX_DAILY_DAYS 存一年，否则每个模型 400 天会白占体积。
  // 键用上游 key，避免 deepseek-flash / DeepSeek-Flash 裂成两条线。
  const model = modelStatsKey(r.model).key;
  if (!rollup.byModelDay[edition]) rollup.byModelDay[edition] = {};
  if (!rollup.byModelDay[edition][model]) rollup.byModelDay[edition][model] = {};
  const modelDays = rollup.byModelDay[edition][model];
  if (!modelDays[key]) modelDays[key] = { tokens: 0, requests: 0 };
  modelDays[key].tokens += r.totalTokens || 0;
  modelDays[key].requests += 1;
}

/** 只保留最近 MAX_DAILY_DAYS 天的按天数据，终身累计不受影响 */
function pruneRollup(rollup) {
  const keep = new Set(recentDayKeys(MAX_DAILY_DAYS));
  for (const edition of Object.keys(rollup.byDay)) {
    const days = rollup.byDay[edition];
    for (const day of Object.keys(days)) {
      if (!keep.has(day)) delete days[day];
    }
  }
  // 模型趋势只留趋势图能用到的那几周
  const keepModel = new Set(recentDayKeys(MODEL_TREND_DAYS));
  for (const edition of Object.keys(rollup.byModelDay)) {
    const models = rollup.byModelDay[edition];
    for (const model of Object.keys(models)) {
      const days = models[model];
      for (const day of Object.keys(days)) {
        if (!keepModel.has(day)) delete days[day];
      }
      if (Object.keys(days).length === 0) delete models[model];
    }
  }
}

/**
 * 模型键归一化迁移。
 *
 * v1.1.33 之前的 byModelDay 用**原始**模型字符串作键，于是 `deepseek-flash`
 * 与 `DeepSeek-Flash` 会各占一条，同一模型在趋势图里裂成两条线。这里把已有
 * 的键换成上游 key 并合并同一天的数值；幂等，键已经是归一化形态时什么都不做。
 */
function normalizeModelKeys(rollup) {
  let changed = false;
  for (const edition of Object.keys(rollup.byModelDay || {})) {
    const models = rollup.byModelDay[edition];
    const merged = {};
    for (const [rawName, days] of Object.entries(models)) {
      const key = modelStatsKey(rawName).key;
      if (key !== rawName) changed = true;
      if (!merged[key]) merged[key] = {};
      for (const [day, cell] of Object.entries(days)) {
        const target = merged[key][day];
        if (!target) merged[key][day] = { tokens: cell.tokens || 0, requests: cell.requests || 0 };
        else {
          target.tokens += cell.tokens || 0;
          target.requests += cell.requests || 0;
        }
      }
    }
    rollup.byModelDay[edition] = merged;
  }
  return changed;
}

/**
 * 老数据迁移：历史版本只存了明细，没有 rollup。
 * 用现有明细回填一次（能回填多少是多少——超出 5000 条的部分在旧版本里已经丢了），
 * 之后由 applyRollup 增量维护。
 */
function ensureRollup(state) {
  if (state.rollup && typeof state.rollup === "object") {
    if (!state.rollup.byDay) state.rollup.byDay = {};
    if (!state.rollup.lifetime) state.rollup.lifetime = {};
    // 老版本（v1.1.32 之前）没有按模型趋势：用明细补一次，之后增量维护
    if (!state.rollup.byModelDay) {
      state.rollup.byModelDay = {};
      for (const r of state.records || []) {
        const day = dayKey(r.ts);
        if (!recentDayKeys(MODEL_TREND_DAYS).includes(day)) continue;
        const edition = editionKey(r.edition);
        const model = modelStatsKey(r.model).key;
        if (!state.rollup.byModelDay[edition]) state.rollup.byModelDay[edition] = {};
        if (!state.rollup.byModelDay[edition][model]) state.rollup.byModelDay[edition][model] = {};
        const days = state.rollup.byModelDay[edition][model];
        if (!days[day]) days[day] = { tokens: 0, requests: 0 };
        days[day].tokens += r.totalTokens || 0;
        days[day].requests += 1;
      }
      return true;
    }
    // 键可能还是 v1.1.33 之前的原始模型名，归一化一次（幂等）
    return normalizeModelKeys(state.rollup);
  }
  const rollup = emptyRollup();
  for (const r of state.records || []) applyRollup(rollup, r);
  state.rollup = rollup;
  return true;
}

export function recordUsage(entry) {
  const state = loadJson("usage.json", null) || emptyState();
  if (!Array.isArray(state.records)) state.records = [];
  ensureRollup(state);
  const record = {
    // 允许显式传入时间（导入历史数据 / 测试回放），默认取当前时刻
    ts: Number(entry.ts) > 0 ? Number(entry.ts) : Date.now(),
    edition: entry.edition,
    accountId: entry.accountId || "",
    accountName: entry.accountName || "",
    model: entry.model || "auto",
    promptTokens: entry.promptTokens || 0,
    completionTokens: entry.completionTokens || 0,
    totalTokens: entry.totalTokens || 0,
    durationMs: entry.durationMs || 0,
    success: entry.success !== false,
    error: entry.error || "",
    api: entry.api || "chat",
  };
  state.records.push(record);
  if (state.records.length > MAX_RECORDS) {
    state.records = state.records.slice(-MAX_RECORDS);
  }
  applyRollup(state.rollup, record);
  pruneRollup(state.rollup);
  // totals 保持与终身累计一致，避免旧字段与新窗口统计打架
  state.totals = lifetimeBucket(state.rollup, null);
  saveJson("usage.json", state);
  return record;
}

/**
 * 某档位（或不限档位）的终身累计。
 * @param {object} rollup
 * @param {string|null} edition  null = 所有档位相加
 */
function lifetimeBucket(rollup, edition) {
  const out = emptyBucket();
  if (!rollup?.lifetime) return out;
  if (edition) return { ...out, ...(rollup.lifetime[edition] || {}) };
  for (const bucket of Object.values(rollup.lifetime)) mergeBuckets(out, bucket);
  return out;
}

/** 某档位在给定日期集合内的累计 */
function windowBucket(rollup, edition, days) {
  const out = emptyBucket();
  if (!rollup?.byDay) return out;
  const wanted = new Set(days);
  const editions = edition ? [edition] : Object.keys(rollup.byDay);
  for (const ed of editions) {
    const map = rollup.byDay[ed] || {};
    for (const day of wanted) {
      if (map[day]) mergeBuckets(out, map[day]);
    }
  }
  return out;
}

function byRequests(map) {
  return [...map.entries()]
    .map(([name, v]) => ({ name, ...v }))
    .sort((a, b) => b.requests - a.requests);
}

export function usageStats(edition) {
  const state = loadJson("usage.json", null) || emptyState();
  if (!Array.isArray(state.records)) state.records = [];
  const migrated = ensureRollup(state);
  if (migrated) saveJson("usage.json", state);

  const records = edition ? state.records.filter((r) => r.edition === edition) : state.records;
  const byAccount = new Map();
  const byModel = new Map();
  const byApi = new Map();

  for (const r of records) {
    const accKey = r.accountName || r.accountId || "未知账号";
    byAccount.set(accKey, addToBucket(byAccount.get(accKey) || emptyBucket(), r));
    // 按上游 key 归并：deepseek-flash / DeepSeek-Flash / dfmodel 是同一个模型
    const model = modelStatsKey(r.model);
    byModel.set(model.key, addToBucket(byModel.get(model.key) || emptyBucket(), r));
    byApi.set(r.api || "chat", addToBucket(byApi.get(r.api || "chat") || emptyBucket(), r));
  }
  const modelLabels = new Map(records.map((r) => {
    const m = modelStatsKey(r.model);
    return [m.key, m.label];
  }));

  const rollup = state.rollup;

  // 每日趋势取自按天汇总而非明细：明细被裁剪后趋势图不该缺前半段
  const daily = dailySeries(rollup, edition, 30);
  const heatmap = heatmapSeries(rollup, edition, HEATMAP_DAYS);
  const modelDaily = modelDailySeries(rollup, edition, 30);

  return {
    // 总请求 / 输入 / 输出 / 失败：终身累计，不受明细裁剪影响
    totals: lifetimeBucket(rollup, edition),
    // 活动概览：热力图 + 连续天数 / 峰值单日（都来自按天汇总，不受明细裁剪影响）
    activity: activitySummary(rollup, edition, heatmap),
    heatmap,
    modelDaily,
    byAccount: byRequests(byAccount),
    byModel: byRequests(byModel).map((row) => ({ ...row, label: modelLabels.get(row.name) || row.name })),
    byApi: byRequests(byApi),
    daily,
    recent: records.slice(-50).reverse(),
    // 明细能回溯到哪一天，用来提示「分布图仅覆盖这段时间」
    detailSince: records.length > 0 ? dayKey(records[0].ts) : null,
    detailCount: records.length,
  };
}

/** 最近 n 天里有数据的那几天，从早到晚（与旧版「只列有数据的日子」一致） */
function dailySeries(rollup, edition, n) {
  const out = [];
  for (const day of recentDayKeys(n)) {
    const bucket = windowBucket(rollup, edition, [day]);
    if (bucket.requests > 0) out.push({ day, ...bucket });
  }
  return out;
}

/**
 * 活动热力图：按自然日给出每日 Token 消耗。
 * 只返回有数据的日子——没有请求的日子在图上就是空格，不必逐日补齐。
 */
function heatmapSeries(rollup, edition, n) {
  return dailySeries(rollup, edition, n).map((d) => ({
    day: d.day,
    tokens: d.totalTokens,
    requests: d.requests,
  }));
}

/**
 * 按模型 × 天的 Token 趋势，用于多线折线图。
 * 返回 { days: [...], series: [{ name, label, values: [number|null] }] }，
 * values 与 days 对齐；该模型当天没请求就是 null（折线断开而不是画成 0）。
 * 模型按窗口内总量降序，只留前 6 个——再多就没法读了。
 *
 * days 只覆盖**首次到末次有数据**的那一段：固定给满 30 天的话，只在最后几天
 * 有数据时折线会挤在右边缘 1/6 的宽度里，趋势根本看不出来。
 */
function modelDailySeries(rollup, edition, n) {
  const allDays = recentDayKeys(n);
  const editions = edition ? [edition] : Object.keys(rollup.byModelDay || {});
  const totals = new Map();
  for (const ed of editions) {
    const models = rollup.byModelDay?.[ed] || {};
    for (const [model, dayMap] of Object.entries(models)) {
      for (const day of allDays) {
        if (dayMap[day]) totals.set(model, (totals.get(model) || 0) + dayMap[day].tokens);
      }
    }
  }
  // 有数据的日子区间：从最早到最晚一条
  let firstWithData = -1;
  let lastWithData = -1;
  for (let i = 0; i < allDays.length; i += 1) {
    let any = false;
    for (const models of Object.values(rollup.byModelDay || {})) {
      for (const dayMap of Object.values(models)) {
        if (dayMap[allDays[i]]) {
          any = true;
          break;
        }
      }
      if (any) break;
    }
    if (any) {
      if (firstWithData < 0) firstWithData = i;
      lastWithData = i;
    }
  }
  const days = firstWithData >= 0 ? allDays.slice(firstWithData, lastWithData + 1) : allDays;

  const top = [...totals.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([name]) => name);
  const series = top.map((name) => {
    const values = days.map((day) => {
      let sum = null;
      for (const ed of editions) {
        const v = rollup.byModelDay?.[ed]?.[name]?.[day];
        if (v) sum = (sum || 0) + v.tokens;
      }
      return sum;
    });
    // name 是上游 key（归并键），label 是展示名
    return { name, label: modelStatsKey(name).label, values };
  });
  return { days, series };
}

/**
 * 活动概览：有活动的天数、总请求、总 Token、峰值单日、当前/最长连续天数。
 * 全部基于按天汇总，因此不受明细 5000 条上限影响。
 */
function activitySummary(rollup, edition, heatmap) {
  const activeDays = heatmap.length;
  const totalTokens = lifetimeBucket(rollup, edition).totalTokens;
  const totalRequests = lifetimeBucket(rollup, edition).requests;

  let peak = { day: null, tokens: 0 };
  for (const d of heatmap) {
    if (d.tokens > peak.tokens) peak = { day: d.day, tokens: d.tokens };
  }

  // 连续天数：把有数据的日子排序后找最长连续段；当前连续段要求最后一天就是今天
  const daySet = new Set(heatmap.map((d) => d.day));
  const sorted = [...daySet].sort();
  let longest = 0;
  let run = 0;
  let prev = null;
  for (const day of sorted) {
    const isNext = prev ? isNextDay(prev, day) : true;
    run = isNext ? run + 1 : 1;
    if (run > longest) longest = run;
    prev = day;
  }
  // 当前连续：从今天（或昨天，允许今天还没用）往回数
  let current = 0;
  const today = recentDayKeys(1)[0];
  let cursor = daySet.has(today) ? today : null;
  if (!cursor) {
    // 今天还没请求时，从昨天开始算，避免「今天还没用」就把连续数清零
    const yesterday = recentDayKeys(2)[0];
    if (daySet.has(yesterday)) cursor = yesterday;
  }
  while (cursor) {
    current += 1;
    const d = new Date(`${cursor}T12:00:00`);
    d.setDate(d.getDate() - 1);
    cursor = dayKey(d.getTime());
    if (!daySet.has(cursor)) break;
  }

  return {
    activeDays,
    totalRequests,
    totalTokens,
    peakDay: peak.day,
    peakTokens: peak.tokens,
    currentStreak: current,
    longestStreak: longest,
  };
}

/** b 是否是 a 的后一天（本地日历） */
function isNextDay(a, b) {
  const d = new Date(`${a}T12:00:00`);
  d.setDate(d.getDate() + 1);
  return dayKey(d.getTime()) === b;
}
