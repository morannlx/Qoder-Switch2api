//! 反代用量统计：请求数、Token 消耗，按账号 / 模型 / 日期聚合。
//!
//! 两套数据，用途不同，不能互相替代：
//!  - records：最近 5000 条明细，只用来画「按账号 / 模型 / API 分布」与最近请求列表。
//!  - rollup：按天累计的汇总（每档位一份）+ 终身累计。**窗口统计与总消耗只认它**——
//!    明细是按条截断的，一旦跑满 5000 条，早期记录会被裁掉；若用明细算「近 30 天」，
//!    数字会随着裁剪一天天变小，「总消耗」更是永远算不对。
//! 与 Node 版 `server/proxy/usage.js` 的数据结构与语义保持一致。

use std::collections::BTreeMap;
use std::sync::{LazyLock, Mutex};

use serde::{Deserialize, Serialize};

use crate::store::{load_json, save_json};

const MAX_RECORDS: usize = 5000;
/// 按天汇总保留天数：只影响窗口统计能回溯多久，不影响「总消耗」（终身累计单独记）
const MAX_DAILY_DAYS: i64 = 400;
/// 按模型趋势保留天数：趋势图最多看 30 天，多留几天余量
const MODEL_TREND_DAYS: i64 = 35;
/// 热力图回溯天数
const HEATMAP_DAYS: i64 = 365;
/// 每日趋势图的天数
const TREND_DAYS: i64 = 30;

/// usage.json 是读-改-写，并发请求必须串行化，否则会丢记录
static USAGE_WRITE_LOCK: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageRecord {
    pub ts: i64,
    #[serde(default)]
    pub edition: String,
    #[serde(default)]
    pub account_id: String,
    #[serde(default)]
    pub account_name: String,
    #[serde(default = "default_model")]
    pub model: String,
    #[serde(default)]
    pub prompt_tokens: i64,
    #[serde(default)]
    pub completion_tokens: i64,
    #[serde(default)]
    pub total_tokens: i64,
    #[serde(default)]
    pub duration_ms: i64,
    #[serde(default = "default_true")]
    pub success: bool,
    #[serde(default)]
    pub error: String,
    #[serde(default = "default_api")]
    pub api: String,
}

fn default_model() -> String {
    "auto".into()
}
fn default_true() -> bool {
    true
}
fn default_api() -> String {
    "chat".into()
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Bucket {
    pub requests: i64,
    pub prompt_tokens: i64,
    pub completion_tokens: i64,
    pub total_tokens: i64,
    pub errors: i64,
}

impl Bucket {
    fn add(&mut self, r: &UsageRecord) {
        self.requests += 1;
        self.prompt_tokens += r.prompt_tokens;
        self.completion_tokens += r.completion_tokens;
        self.total_tokens += r.total_tokens;
        if !r.success {
            self.errors += 1;
        }
    }

    fn merge(&mut self, other: &Bucket) {
        self.requests += other.requests;
        self.prompt_tokens += other.prompt_tokens;
        self.completion_tokens += other.completion_tokens;
        self.total_tokens += other.total_tokens;
        self.errors += other.errors;
    }
}

/// 按天汇总：edition -> (YYYY-MM-DD -> Bucket)
type DailyMap = BTreeMap<String, BTreeMap<String, Bucket>>;
/// 终身累计：edition -> Bucket
type LifetimeMap = BTreeMap<String, Bucket>;
/// 按模型 × 天：edition -> model -> day -> {tokens, requests}
type ModelDayMap = BTreeMap<String, BTreeMap<String, BTreeMap<String, ModelDayCell>>>;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ModelDayCell {
    #[serde(default)]
    pub tokens: i64,
    #[serde(default)]
    pub requests: i64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Rollup {
    #[serde(default)]
    pub by_day: DailyMap,
    #[serde(default)]
    pub lifetime: LifetimeMap,
    #[serde(default)]
    pub by_model_day: ModelDayMap,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct UsageState {
    #[serde(default)]
    pub records: Vec<UsageRecord>,
    #[serde(default)]
    pub rollup: Option<Rollup>,
}

pub fn record_usage(entry: UsageRecord) {
    let _guard = USAGE_WRITE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut state = load_json::<UsageState>("usage.json");
    let mut record = entry;
    record.ts = crate::crypto::now_ms();
    state.records.push(record.clone());
    if state.records.len() > MAX_RECORDS {
        let excess = state.records.len() - MAX_RECORDS;
        state.records.drain(..excess);
    }
    let mut rollup = ensure_rollup(&mut state);
    apply_rollup(&mut rollup, &record);
    prune_rollup(&mut rollup);
    state.rollup = Some(rollup);
    save_json("usage.json", &state);
}

fn day_key(ts: i64) -> String {
    use chrono::{Local, TimeZone};
    Local
        .timestamp_millis_opt(ts)
        .single()
        .unwrap_or_else(Local::now)
        .format("%Y-%m-%d")
        .to_string()
}

/// 最近 n 天（含今天）的本地日期键，从早到晚
fn recent_day_keys(n: i64) -> Vec<String> {
    use chrono::{Duration, Local};
    let today = Local::now().date_naive();
    (0..n)
        .map(|i| (today - Duration::days(n - 1 - i)).format("%Y-%m-%d").to_string())
        .collect()
}

fn edition_key(edition: &str) -> String {
    if edition.is_empty() {
        "unknown".into()
    } else {
        edition.to_string()
    }
}

/// 把一条记录计入按天汇总与终身累计。
/// 终身累计只增不减：它是「总消耗」的唯一来源，不能从会被裁剪的明细重算。
fn apply_rollup(rollup: &mut Rollup, r: &UsageRecord) {
    let day = day_key(r.ts);
    let edition = edition_key(&r.edition);
    rollup
        .by_day
        .entry(edition.clone())
        .or_default()
        .entry(day.clone())
        .or_default()
        .add(r);
    rollup.lifetime.entry(edition.clone()).or_default().add(r);
    // 按模型 × 天的趋势，键用上游 key 归并（见 gateway::stats_model_key）
    let model = crate::gateway::stats_model_key(&r.model);
    let cell = rollup
        .by_model_day
        .entry(edition)
        .or_default()
        .entry(model)
        .or_default()
        .entry(day)
        .or_default();
    cell.tokens += r.total_tokens;
    cell.requests += 1;
}

/// 只保留最近 MAX_DAILY_DAYS 天的按天数据，终身累计不受影响
fn prune_rollup(rollup: &mut Rollup) {
    let keep: std::collections::HashSet<String> = recent_day_keys(MAX_DAILY_DAYS).into_iter().collect();
    for days in rollup.by_day.values_mut() {
        days.retain(|day, _| keep.contains(day));
    }
    // 模型趋势只留趋势图能用到的那几周
    let keep_model: std::collections::HashSet<String> =
        recent_day_keys(MODEL_TREND_DAYS).into_iter().collect();
    for models in rollup.by_model_day.values_mut() {
        for days in models.values_mut() {
            days.retain(|day, _| keep_model.contains(day));
        }
        models.retain(|_, days| !days.is_empty());
    }
}

/// 模型键归一化迁移。
///
/// 早期版本用**原始**模型字符串作 byModelDay 的键，于是 `deepseek-flash`
/// 与 `DeepSeek-Flash` 会各占一条，同一模型在趋势图里裂成两条线。这里把已有
/// 的键换成上游 key 并合并同一天的数值；幂等，键已归一化时不做任何事。
fn normalize_model_keys(rollup: &mut Rollup) -> bool {
    let mut changed = false;
    for models in rollup.by_model_day.values_mut() {
        let mut merged: BTreeMap<String, BTreeMap<String, ModelDayCell>> = BTreeMap::new();
        let entries: Vec<(String, BTreeMap<String, ModelDayCell>)> = std::mem::take(models).into_iter().collect();
        for (raw_name, days) in entries {
            let key = crate::gateway::stats_model_key(&raw_name);
            if key != raw_name {
                changed = true;
            }
            let target = merged.entry(key).or_default();
            for (day, cell) in days {
                let slot = target.entry(day).or_default();
                slot.tokens += cell.tokens;
                slot.requests += cell.requests;
            }
        }
        *models = merged;
    }
    changed
}

/// 老数据迁移：历史版本只存了明细，没有 rollup。
/// 用现有明细回填一次（能回填多少是多少——超出 5000 条的部分在旧版本里已经丢了），
/// 之后由 apply_rollup 增量维护。
fn ensure_rollup(state: &mut UsageState) -> Rollup {
    if let Some(mut rollup) = state.rollup.take() {
        // 老版本（没有按模型趋势）：用明细补一次，之后增量维护
        if rollup.by_model_day.is_empty() {
            let keep: std::collections::HashSet<String> =
                recent_day_keys(MODEL_TREND_DAYS).into_iter().collect();
            for r in &state.records {
                if !keep.contains(&day_key(r.ts)) {
                    continue;
                }
                let edition = edition_key(&r.edition);
                let model = crate::gateway::stats_model_key(&r.model);
                let cell = rollup
                    .by_model_day
                    .entry(edition)
                    .or_default()
                    .entry(model)
                    .or_default()
                    .entry(day_key(r.ts))
                    .or_default();
                cell.tokens += r.total_tokens;
                cell.requests += 1;
            }
            return rollup;
        }
        // 键可能还是原始模型名，归一化一次（幂等）
        normalize_model_keys(&mut rollup);
        return rollup;
    }
    let mut rollup = Rollup::default();
    for r in &state.records {
        apply_rollup(&mut rollup, r);
    }
    rollup
}

fn lifetime_bucket(rollup: &Rollup, edition: Option<&str>) -> Bucket {
    let mut out = Bucket::default();
    match edition {
        Some(ed) => {
            if let Some(bucket) = rollup.lifetime.get(ed) {
                out.merge(bucket);
            }
        }
        None => {
            for bucket in rollup.lifetime.values() {
                out.merge(bucket);
            }
        }
    }
    out
}

fn window_bucket(rollup: &Rollup, edition: Option<&str>, days: &[String]) -> Bucket {
    let mut out = Bucket::default();
    let wanted: std::collections::HashSet<&String> = days.iter().collect();
    let editions: Vec<&String> = match edition {
        Some(ed) => rollup.by_day.get_key_value(ed).map(|(k, _)| vec![k]).unwrap_or_default(),
        None => rollup.by_day.keys().collect(),
    };
    for ed in editions {
        if let Some(map) = rollup.by_day.get(ed) {
            for (day, bucket) in map {
                if wanted.contains(day) {
                    out.merge(bucket);
                }
            }
        }
    }
    out
}

/// 前端形态：{ name, requests, promptTokens, ... }
#[derive(Debug, Clone, Serialize)]
pub struct NamedBucket {
    pub name: String,
    #[serde(flatten)]
    pub bucket: Bucket,
}

/// 带展示名的模型统计行
#[derive(Debug, Clone, Serialize)]
pub struct NamedModelBucket {
    pub name: String,
    pub label: String,
    #[serde(flatten)]
    pub bucket: Bucket,
}

/// 热力图的一格
#[derive(Debug, Clone, Serialize)]
pub struct HeatmapDay {
    pub day: String,
    pub tokens: i64,
    pub requests: i64,
}

/// 活动概览：活跃天数 / 峰值单日 / 连续天数
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivitySummary {
    pub active_days: i64,
    pub total_requests: i64,
    pub total_tokens: i64,
    pub peak_day: Option<String>,
    pub peak_tokens: i64,
    pub current_streak: i64,
    pub longest_streak: i64,
}

/// 单个模型的每日序列（values 与 days 对齐，当天没请求为 null）
#[derive(Debug, Clone, Serialize)]
pub struct ModelSeries {
    pub name: String,
    pub label: String,
    pub values: Vec<Option<i64>>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ModelDaily {
    pub days: Vec<String>,
    pub series: Vec<ModelSeries>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageStats {
    pub totals: Bucket,
    pub by_account: Vec<NamedBucket>,
    pub by_model: Vec<NamedModelBucket>,
    pub by_api: Vec<NamedBucket>,
    pub daily: Vec<NamedBucket>,
    pub heatmap: Vec<HeatmapDay>,
    pub activity: ActivitySummary,
    pub model_daily: ModelDaily,
    pub recent: Vec<UsageRecord>,
    /// 明细能回溯到哪一天（分布图只覆盖这段时间）
    pub detail_since: Option<String>,
    pub detail_count: usize,
}

pub fn usage_stats(edition: Option<&str>) -> UsageStats {
    let mut state = load_json::<UsageState>("usage.json");
    let migrated = state.rollup.is_none();
    let rollup = ensure_rollup(&mut state);
    if migrated {
        state.rollup = Some(rollup.clone());
        save_json("usage.json", &state);
    }

    let records: Vec<&UsageRecord> = state
        .records
        .iter()
        .filter(|r| edition.map(|e| r.edition == e).unwrap_or(true))
        .collect();

    // 分布图与最近列表取自明细（本来只关心近期，裁剪无影响）
    let mut by_account: BTreeMap<String, Bucket> = BTreeMap::new();
    let mut by_model: BTreeMap<String, Bucket> = BTreeMap::new();
    let mut by_api: BTreeMap<String, Bucket> = BTreeMap::new();
    for r in &records {
        by_account
            .entry(if r.account_name.is_empty() { "未知账号".into() } else { r.account_name.clone() })
            .or_default()
            .add(r);
        // 按上游 key 归并：deepseek-flash / DeepSeek-Flash / dfmodel 是同一个模型
        by_model
            .entry(crate::gateway::stats_model_key(&r.model))
            .or_default()
            .add(r);
        by_api
            .entry(if r.api.is_empty() { "chat".into() } else { r.api.clone() })
            .or_default()
            .add(r);
    }

    let sort_by_requests = |mut list: Vec<NamedBucket>| {
        list.sort_by(|a, b| b.bucket.requests.cmp(&a.bucket.requests));
        list
    };
    let named = |map: BTreeMap<String, Bucket>| -> Vec<NamedBucket> {
        map.into_iter().map(|(name, bucket)| NamedBucket { name, bucket }).collect()
    };

    // 每日趋势取自按天汇总而非明细：明细被裁剪后趋势图不该缺前半段
    let mut daily: Vec<NamedBucket> = Vec::new();
    for day in recent_day_keys(TREND_DAYS) {
        let bucket = window_bucket(&rollup, edition, std::slice::from_ref(&day));
        if bucket.requests > 0 {
            daily.push(NamedBucket { name: day, bucket });
        }
    }

    let totals = lifetime_bucket(&rollup, edition);

    // 热力图 / 活动概览 / 模型趋势
    let heatmap: Vec<HeatmapDay> = daily_series(&rollup, edition, HEATMAP_DAYS)
        .into_iter()
        .map(|(day, bucket)| HeatmapDay { day, tokens: bucket.total_tokens, requests: bucket.requests })
        .collect();
    let activity = activity_summary(&totals, &heatmap);
    let model_daily = model_daily_series(&rollup, edition, TREND_DAYS);

    let mut by_model_rows: Vec<NamedModelBucket> = sort_by_requests(named(by_model))
        .into_iter()
        .map(|row| NamedModelBucket {
            label: crate::gateway::stats_model_label(&row.name),
            name: row.name,
            bucket: row.bucket,
        })
        .collect();
    by_model_rows.sort_by(|a, b| b.bucket.requests.cmp(&a.bucket.requests));

    // 与 Node 版一致：最新记录在前
    let recent: Vec<UsageRecord> = records.iter().rev().take(50).map(|r| (*r).clone()).collect();
    let detail_since = records.first().map(|r| day_key(r.ts));

    UsageStats {
        totals,
        by_account: sort_by_requests(named(by_account)),
        by_model: by_model_rows,
        by_api: sort_by_requests(named(by_api)),
        daily,
        heatmap,
        activity,
        model_daily,
        recent,
        detail_since,
        detail_count: records.len(),
    }
}

/// 最近 n 天里有数据的那几天，从早到晚
fn daily_series(rollup: &Rollup, edition: Option<&str>, n: i64) -> Vec<(String, Bucket)> {
    let mut out = Vec::new();
    for day in recent_day_keys(n) {
        let bucket = window_bucket(rollup, edition, std::slice::from_ref(&day));
        if bucket.requests > 0 {
            out.push((day, bucket));
        }
    }
    out
}

/// 活动概览：活跃天数、峰值单日、当前/最长连续天数
fn activity_summary(total: &Bucket, heatmap: &[HeatmapDay]) -> ActivitySummary {
    let mut peak_day: Option<String> = None;
    let mut peak_tokens = 0i64;
    for d in heatmap {
        if d.tokens > peak_tokens {
            peak_tokens = d.tokens;
            peak_day = Some(d.day.clone());
        }
    }

    let days: std::collections::BTreeSet<&str> = heatmap.iter().map(|d| d.day.as_str()).collect();

    // 最长连续段
    let mut longest = 0i64;
    let mut run = 0i64;
    let mut prev: Option<String> = None;
    for day in &days {
        let is_next = prev.as_ref().map(|p| next_day(p) == **day).unwrap_or(true);
        run = if is_next { run + 1 } else { 1 };
        if run > longest {
            longest = run;
        }
        prev = Some((*day).to_string());
    }

    // 当前连续：从今天往回数；今天还没请求时从昨天起算，避免清零
    let today = recent_day_keys(1).into_iter().next().unwrap_or_default();
    let yesterday = recent_day_keys(2).into_iter().next().unwrap_or_default();
    let mut cursor = if days.contains(today.as_str()) {
        Some(today)
    } else if days.contains(yesterday.as_str()) {
        Some(yesterday)
    } else {
        None
    };
    let mut current = 0i64;
    while let Some(day) = cursor {
        current += 1;
        let prev_day = previous_day(&day);
        cursor = if days.contains(prev_day.as_str()) { Some(prev_day) } else { None };
    }

    ActivitySummary {
        active_days: heatmap.len() as i64,
        total_requests: total.requests,
        total_tokens: total.total_tokens,
        peak_day,
        peak_tokens,
        current_streak: current,
        longest_streak: longest,
    }
}

fn next_day(day: &str) -> String {
    use chrono::NaiveDate;
    NaiveDate::parse_from_str(day, "%Y-%m-%d")
        .ok()
        .and_then(|d| d.succ_opt())
        .map(|d| d.format("%Y-%m-%d").to_string())
        .unwrap_or_default()
}

fn previous_day(day: &str) -> String {
    use chrono::NaiveDate;
    NaiveDate::parse_from_str(day, "%Y-%m-%d")
        .ok()
        .and_then(|d| d.pred_opt())
        .map(|d| d.format("%Y-%m-%d").to_string())
        .unwrap_or_default()
}

/// 按模型 × 天的趋势；模型按窗口内总量降序，只留前 6 个。
///
/// days 只覆盖**首次到末次有数据**的那一段：固定给满 30 天的话，只在最后几天
/// 有数据时折线会挤在右边缘一小段里，趋势根本看不出来。
fn model_daily_series(rollup: &Rollup, edition: Option<&str>, n: i64) -> ModelDaily {
    let all_days = recent_day_keys(n);
    let editions: Vec<&String> = match edition {
        Some(ed) => rollup.by_model_day.get_key_value(ed).map(|(k, _)| vec![k]).unwrap_or_default(),
        None => rollup.by_model_day.keys().collect(),
    };

    let mut totals: BTreeMap<&str, i64> = BTreeMap::new();
    for ed in &editions {
        if let Some(models) = rollup.by_model_day.get(*ed) {
            for (model, day_map) in models {
                for day in &all_days {
                    if let Some(cell) = day_map.get(day) {
                        *totals.entry(model.as_str()).or_default() += cell.tokens;
                    }
                }
            }
        }
    }

    // 有数据的日子区间：从最早到最晚一条
    let mut first_with_data: Option<usize> = None;
    let mut last_with_data: Option<usize> = None;
    for (i, day) in all_days.iter().enumerate() {
        let any = rollup
            .by_model_day
            .values()
            .any(|models| models.values().any(|day_map| day_map.contains_key(day)));
        if any {
            if first_with_data.is_none() {
                first_with_data = Some(i);
            }
            last_with_data = Some(i);
        }
    }
    let days: Vec<String> = match (first_with_data, last_with_data) {
        (Some(a), Some(b)) => all_days[a..=b].to_vec(),
        _ => all_days,
    };

    let mut ranked: Vec<(&str, i64)> = totals.into_iter().collect();
    ranked.sort_by(|a, b| b.1.cmp(&a.1));
    ranked.truncate(6);

    let series = ranked
        .into_iter()
        .map(|(name, _)| {
            let values = days
                .iter()
                .map(|day| {
                    let mut sum: Option<i64> = None;
                    for ed in &editions {
                        if let Some(cell) = rollup.by_model_day.get(*ed).and_then(|m| m.get(name)).and_then(|d| d.get(day)) {
                            sum = Some(sum.unwrap_or(0) + cell.tokens);
                        }
                    }
                    sum
                })
                .collect();
            ModelSeries {
                label: crate::gateway::stats_model_label(name),
                name: name.to_string(),
                values,
            }
        })
        .collect();

    ModelDaily { days, series }
}

#[cfg(test)]
mod tests {
    use super::{apply_rollup, lifetime_bucket, prune_rollup, recent_day_keys, window_bucket, Bucket, Rollup, UsageRecord};

    fn rec(ts: i64, total: i64) -> UsageRecord {
        UsageRecord {
            ts,
            edition: "domestic".into(),
            total_tokens: total,
            prompt_tokens: total,
            success: true,
            model: "m".into(),
            api: "chat".into(),
            ..Default::default()
        }
    }

    #[test]
    fn window_and_lifetime_are_independent() {
        let mut rollup = Rollup::default();
        let now = crate::crypto::now_ms();
        // 200 天前的一条：只进终身累计，不进 30 天窗口
        apply_rollup(&mut rollup, &rec(now - 200 * 86_400_000, 1500));
        apply_rollup(&mut rollup, &rec(now, 15));

        assert_eq!(window_bucket(&rollup, None, &recent_day_keys(30)).total_tokens, 15);
        assert_eq!(lifetime_bucket(&rollup, None).total_tokens, 1515);
        assert_eq!(window_bucket(&rollup, None, &recent_day_keys(1)).total_tokens, 15);
    }

    #[test]
    fn lifetime_survives_daily_pruning() {
        let mut rollup = Rollup::default();
        let now = crate::crypto::now_ms();
        apply_rollup(&mut rollup, &rec(now - 500 * 86_400_000, 999));
        apply_rollup(&mut rollup, &rec(now, 1));
        // 按天数据超过保留期被裁掉，终身累计不受影响
        prune_rollup(&mut rollup);
        let days = rollup.by_day.get("domestic").map(|d| d.len()).unwrap_or(0);
        assert_eq!(days, 1, "只应保留保留期内的按天数据");
        assert_eq!(lifetime_bucket(&rollup, None).total_tokens, 1000);
    }

    #[test]
    fn edition_filter_isolates_buckets() {
        let mut rollup = Rollup::default();
        let now = crate::crypto::now_ms();
        apply_rollup(&mut rollup, &rec(now, 100));
        let mut intl = rec(now, 7);
        intl.edition = "international".into();
        apply_rollup(&mut rollup, &intl);

        assert_eq!(lifetime_bucket(&rollup, Some("domestic")).total_tokens, 100);
        assert_eq!(lifetime_bucket(&rollup, Some("international")).total_tokens, 7);
        assert_eq!(lifetime_bucket(&rollup, None).total_tokens, 107);
        assert_eq!(window_bucket(&rollup, Some("domestic"), &recent_day_keys(1)).total_tokens, 100);
    }

    #[test]
    fn window_boundaries_are_inclusive_of_today() {
        let days = recent_day_keys(7);
        assert_eq!(days.len(), 7);
        // 从早到晚，最后一个是今天
        assert!(days.windows(2).all(|w| w[0] < w[1]));
        assert_eq!(days.last(), recent_day_keys(1).last());
    }

    #[test]
    fn merging_empty_rollup_yields_zero_bucket() {
        let rollup = Rollup::default();
        let bucket: Bucket = lifetime_bucket(&rollup, None);
        assert_eq!(bucket.total_tokens, 0);
        assert_eq!(bucket.requests, 0);
    }

    fn rec_at(ts: i64, total: i64, model: &str) -> UsageRecord {
        UsageRecord {
            ts,
            edition: "domestic".into(),
            total_tokens: total,
            prompt_tokens: total,
            success: true,
            model: model.into(),
            api: "chat".into(),
            ..Default::default()
        }
    }

    #[test]
    fn model_daily_merges_aliases_and_keeps_nulls() {
        use super::apply_rollup;
        let mut rollup = Rollup::default();
        let now = crate::crypto::now_ms();
        // 同一模型三种拼写：应归并成一条
        apply_rollup(&mut rollup, &rec_at(now, 100, "deepseek-flash"));
        apply_rollup(&mut rollup, &rec_at(now, 50, "DeepSeek-Flash"));
        apply_rollup(&mut rollup, &rec_at(now - 2 * 86_400_000, 70, "dfmodel"));

        let md = super::model_daily_series(&rollup, Some("domestic"), 30);
        assert_eq!(md.series.len(), 1, "三种拼写应归并为一个模型");
        let s = &md.series[0];
        assert_eq!(s.name, "dfmodel", "归并键是上游 key");
        assert_eq!(s.label, "DeepSeek-Flash", "展示名可读");
        assert_eq!(s.values.len(), md.days.len(), "values 与 days 对齐");
        let last = s.values.len() - 1;
        assert_eq!(s.values[last], Some(150), "今天两条相加");
        assert_eq!(s.values[last - 1], None, "昨天没请求 = null（折线断开）");
        assert_eq!(s.values[last - 2], Some(70));
    }

    #[test]
    fn activity_counts_streaks_and_peak() {
        use super::{activity_summary, Bucket, HeatmapDay};
        let mut total = Bucket::default();
        total.requests = 4;
        total.total_tokens = 560;
        let heatmap = vec![
            HeatmapDay { day: "2026-11-01".into(), tokens: 500, requests: 1 },
            HeatmapDay { day: "2026-11-07".into(), tokens: 30, requests: 1 },
            HeatmapDay { day: "2026-11-08".into(), tokens: 20, requests: 1 },
            HeatmapDay { day: "2026-11-09".into(), tokens: 10, requests: 1 },
        ];
        let a = activity_summary(&total, &heatmap);
        assert_eq!(a.active_days, 4);
        assert_eq!(a.peak_tokens, 500);
        assert_eq!(a.peak_day.as_deref(), Some("2026-11-01"));
        assert_eq!(a.longest_streak, 3, "11-07/08/09 连续三天");
    }

    #[test]
    fn model_trend_is_capped_and_sorted() {
        use super::apply_rollup;
        let mut rollup = Rollup::default();
        let now = crate::crypto::now_ms();
        for i in 0..9 {
            apply_rollup(&mut rollup, &rec_at(now, (i + 1) * 10, &format!("model-{i}")));
        }
        let md = super::model_daily_series(&rollup, None, 30);
        assert_eq!(md.series.len(), 6, "只留前 6 个模型");
        assert_eq!(md.series[0].name, "model-8", "总量最高的排第一");
        let totals: Vec<i64> = md.series.iter().map(|s| s.values.iter().flatten().sum()).collect();
        assert!(totals.windows(2).all(|w| w[0] >= w[1]), "按总量降序");
    }

    #[test]
    fn model_day_pruning_keeps_lifetime() {
        use super::apply_rollup;
        let mut rollup = Rollup::default();
        let now = crate::crypto::now_ms();
        apply_rollup(&mut rollup, &rec_at(now - 100 * 86_400_000, 777, "dfmodel"));
        apply_rollup(&mut rollup, &rec_at(now, 1, "dfmodel"));
        super::prune_rollup(&mut rollup);
        let md = super::model_daily_series(&rollup, None, 30);
        let kept: i64 = md.series.iter().flat_map(|s| s.values.iter().flatten()).sum();
        assert_eq!(kept, 1, "超出趋势窗口的按模型数据被裁掉");
        assert_eq!(super::lifetime_bucket(&rollup, None).total_tokens, 778, "终身累计不受影响");
    }


    #[test]
    fn normalizes_raw_model_keys_and_merges_same_day() {
        use super::{ModelDayCell, Rollup};
        let mut rollup = Rollup::default();
        let mut models = std::collections::BTreeMap::new();
        for (name, tokens) in [("deepseek-flash", 100i64), ("DeepSeek-Flash", 50)] {
            let mut days = std::collections::BTreeMap::new();
            days.insert("2026-11-09".to_string(), ModelDayCell { tokens, requests: 1 });
            models.insert(name.to_string(), days);
        }
        rollup.by_model_day.insert("domestic".into(), models);

        assert!(super::normalize_model_keys(&mut rollup), "原始名应被改写");
        let merged = &rollup.by_model_day["domestic"];
        assert_eq!(merged.len(), 1, "两种拼写合并成一条");
        assert_eq!(merged["dfmodel"]["2026-11-09"].tokens, 150);
        assert_eq!(merged["dfmodel"]["2026-11-09"].requests, 2);
        // 幂等：再跑一次不变、且报告无改动
        assert!(!super::normalize_model_keys(&mut rollup));
        assert_eq!(rollup.by_model_day["domestic"]["dfmodel"]["2026-11-09"].tokens, 150);
    }

}
