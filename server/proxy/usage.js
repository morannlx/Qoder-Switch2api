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

const MAX_RECORDS = 5000;
/** 按天汇总保留天数：只影响窗口统计能回溯多久，不影响「总消耗」（终身累计单独记） */
const MAX_DAILY_DAYS = 400;

function emptyBucket() {
  return { requests: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, errors: 0 };
}

function emptyState() {
  return { records: [], totals: emptyBucket(), rollup: emptyRollup() };
}

function emptyRollup() {
  return { byDay: {}, lifetime: {} };
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
    return false;
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
    byModel.set(r.model || "auto", addToBucket(byModel.get(r.model || "auto") || emptyBucket(), r));
    byApi.set(r.api || "chat", addToBucket(byApi.get(r.api || "chat") || emptyBucket(), r));
  }

  const rollup = state.rollup;

  // 每日趋势取自按天汇总而非明细：明细被裁剪后趋势图不该缺前半段
  const daily = dailySeries(rollup, edition, 30);

  return {
    // 总请求 / 输入 / 输出 / 失败：终身累计，不受明细裁剪影响
    totals: lifetimeBucket(rollup, edition),
    // 时间窗口：今日 / 近 7 日 / 近 15 日 / 近 30 日 / 总消耗
    windows: {
      today: windowBucket(rollup, edition, recentDayKeys(1)),
      d7: windowBucket(rollup, edition, recentDayKeys(7)),
      d15: windowBucket(rollup, edition, recentDayKeys(15)),
      d30: windowBucket(rollup, edition, recentDayKeys(30)),
      all: lifetimeBucket(rollup, edition),
    },
    byAccount: byRequests(byAccount),
    byModel: byRequests(byModel),
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
