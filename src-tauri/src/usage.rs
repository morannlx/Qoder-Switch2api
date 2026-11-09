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

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Rollup {
    #[serde(default)]
    pub by_day: DailyMap,
    #[serde(default)]
    pub lifetime: LifetimeMap,
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
        .entry(day)
        .or_default()
        .add(r);
    rollup.lifetime.entry(edition).or_default().add(r);
}

/// 只保留最近 MAX_DAILY_DAYS 天的按天数据，终身累计不受影响
fn prune_rollup(rollup: &mut Rollup) {
    let keep: std::collections::HashSet<String> = recent_day_keys(MAX_DAILY_DAYS).into_iter().collect();
    for days in rollup.by_day.values_mut() {
        days.retain(|day, _| keep.contains(day));
    }
}

/// 老数据迁移：历史版本只存了明细，没有 rollup。
/// 用现有明细回填一次（能回填多少是多少——超出 5000 条的部分在旧版本里已经丢了），
/// 之后由 apply_rollup 增量维护。
fn ensure_rollup(state: &mut UsageState) -> Rollup {
    if let Some(rollup) = state.rollup.take() {
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

/// 时间窗口统计：今日 / 近 7 日 / 近 15 日 / 近 30 日 / 总消耗
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageWindows {
    pub today: Bucket,
    pub d7: Bucket,
    pub d15: Bucket,
    pub d30: Bucket,
    pub all: Bucket,
}

/// 前端形态：{ name, requests, promptTokens, ... }
#[derive(Debug, Clone, Serialize)]
pub struct NamedBucket {
    pub name: String,
    #[serde(flatten)]
    pub bucket: Bucket,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageStats {
    pub totals: Bucket,
    pub windows: UsageWindows,
    pub by_account: Vec<NamedBucket>,
    pub by_model: Vec<NamedBucket>,
    pub by_api: Vec<NamedBucket>,
    pub daily: Vec<NamedBucket>,
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
        by_model
            .entry(if r.model.is_empty() { "auto".into() } else { r.model.clone() })
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

    let windows = UsageWindows {
        today: window_bucket(&rollup, edition, &recent_day_keys(1)),
        d7: window_bucket(&rollup, edition, &recent_day_keys(7)),
        d15: window_bucket(&rollup, edition, &recent_day_keys(15)),
        d30: window_bucket(&rollup, edition, &recent_day_keys(30)),
        all: lifetime_bucket(&rollup, edition),
    };

    // 与 Node 版一致：最新记录在前
    let recent: Vec<UsageRecord> = records.iter().rev().take(50).map(|r| (*r).clone()).collect();
    let detail_since = records.first().map(|r| day_key(r.ts));

    UsageStats {
        totals: windows.all.clone(),
        windows,
        by_account: sort_by_requests(named(by_account)),
        by_model: sort_by_requests(named(by_model)),
        by_api: sort_by_requests(named(by_api)),
        daily,
        recent,
        detail_since,
        detail_count: records.len(),
    }
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
}
