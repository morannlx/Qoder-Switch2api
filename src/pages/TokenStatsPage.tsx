import { useEffect, useState } from "react";
import {
  Activity, ArrowDownToLine, ArrowUpFromLine, BarChart3, CalendarClock, CalendarDays, CalendarRange, Infinity, RefreshCw,
  ServerCog, TriangleAlert, Zap,
} from "lucide-react";
import { Link } from "react-router-dom";
import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Legend, Pie, PieChart, ResponsiveContainer, Tooltip as RTooltip,
  XAxis, YAxis,
} from "recharts";

import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { Segmented } from "@/components/segmented";
import { StatCard } from "@/components/stat-card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import * as api from "@/lib/api";
import type { UsageStats } from "@/lib/types";
import { cn } from "@/lib/utils";

const SERIES = [
  "var(--data-series-emerald)",
  "var(--data-series-teal)",
  "var(--data-series-amber)",
  "var(--data-series-rose)",
  "var(--data-series-sky)",
  "var(--data-series-lime)",
  "var(--data-series-indigo)",
  "var(--data-series-violet)",
];

function fmt(n: number): string {
  // 累计量会到十亿级（单条请求就上万 token），分级显示比 2401.2M 可读
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

/** 完整的千分位写法，用于悬停提示 */
function exact(n: number): string {
  return n.toLocaleString("zh-CN");
}

const tooltipStyle = {
  background: "var(--popover)",
  border: "1px solid var(--border)",
  borderRadius: 10,
  fontSize: 12,
  color: "var(--popover-foreground)",
  boxShadow: "0 12px 32px -12px oklch(0.2 0.02 255 / 30%)",
};

/** 消耗窗口的展示顺序与文案 */
const WINDOWS = [
  { key: "today" as const, label: "今日消耗", icon: Zap },
  { key: "d7" as const, label: "近 7 日", icon: CalendarDays },
  { key: "d15" as const, label: "近 15 日", icon: CalendarRange },
  { key: "d30" as const, label: "近 30 日", icon: CalendarClock },
  { key: "all" as const, label: "总消耗", icon: Infinity },
];

/** Token 统计：趋势图 + 按账号 / 模型 / API 分布 */
export default function TokenStatsPage() {
  const [usage, setUsage] = useState<UsageStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [edition, setEdition] = useState<"" | "domestic" | "international">("");

  async function load() {
    setLoading(true);
    setError("");
    try {
      setUsage(await api.api.getUsage(edition || undefined));
    } catch (e) {
      setError(api.asError(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [edition]);

  const daily = usage?.daily ?? [];
  const byModel = usage?.byModel ?? [];
  const byApi = usage?.byApi ?? [];
  const successRate =
    usage && usage.totals.requests > 0
      ? ((usage.totals.requests - usage.totals.errors) / usage.totals.requests) * 100
      : 0;

  return (
    <div>
      <PageHeader
        icon={BarChart3}
        title="Token 统计"
        description="查看反代请求量、输入输出 Token 趋势，以及按账号、模型与 API 类型的分布。"
        actions={
          <>
            <Segmented
              ariaLabel="统计版本"
              value={edition}
              onChange={setEdition}
              options={[
                { value: "", label: "全部" },
                { value: "domestic", label: "国内版" },
                { value: "international", label: "国际版" },
              ]}
            />
            <Button variant="ghost" size="icon" className="size-9" onClick={() => void load()} disabled={loading} aria-label="刷新统计">
              <RefreshCw className={cn(loading && "animate-spin")} />
            </Button>
          </>
        }
      />

      {error ? (
        <Alert variant="destructive" className="mb-5">
          <TriangleAlert />
          <AlertTitle>统计数据加载失败</AlertTitle>
          <AlertDescription className="flex items-center justify-between gap-4">
            <span>{error}</span>
            <Button size="sm" variant="outline" onClick={() => void load()}>重试</Button>
          </AlertDescription>
        </Alert>
      ) : null}

      {loading && !usage ? (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-2.5 sm:gap-3 xl:grid-cols-4">
            {[0, 1, 2, 3].map((i) => <div key={i} className="h-[94px] animate-pulse rounded-2xl border border-border/70 bg-card/60" />)}
          </div>
          <div className="h-80 animate-pulse rounded-2xl border border-border/70 bg-card/60" />
          <div className="grid gap-4 lg:grid-cols-2">
            <div className="h-72 animate-pulse rounded-2xl border border-border/70 bg-card/60" />
            <div className="h-72 animate-pulse rounded-2xl border border-border/70 bg-card/60" />
          </div>
        </div>
      ) : !usage || usage.totals.requests === 0 ? (
        <EmptyState
          icon={ServerCog}
          title="还没有请求记录"
          description="在 API 反代页启用网关，并让客户端发出第一笔请求后，这里会出现趋势与分布。"
          action={
            <Button asChild variant="outline">
              <Link to="/api-proxy/domestic">前往启用反代</Link>
            </Button>
          }
        />
      ) : (
        <div className="space-y-5">
          {/* 时间窗口消耗：今日 / 7 / 15 / 30 日 / 总消耗
              数据来自按天汇总，不受明细 5000 条上限影响 */}
          <Card>
            <CardHeader className="flex-row items-center justify-between">
              <div>
                <CardTitle className="text-[13px]">消耗窗口</CardTitle>
                <p className="mt-1 text-[11px] text-muted-foreground">
                  按自然日统计的 Token 消耗，今日含此刻为止的全部请求。
                </p>
              </div>
              <Badge variant="outline" className="h-6 text-[10.5px] font-normal">
                累计 {fmt(usage.windows.all.totalTokens)}
              </Badge>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 gap-2.5 sm:gap-3 xl:grid-cols-5">
                {WINDOWS.map((w) => {
                  const bucket = usage.windows[w.key];
                  const share = usage.windows.all.totalTokens
                    ? (bucket.totalTokens / usage.windows.all.totalTokens) * 100
                    : 0;
                  return (
                    <div
                      key={w.key}
                      className="relative overflow-hidden rounded-xl border border-border/75 bg-muted/15 px-3 py-3"
                      title={`${exact(bucket.totalTokens)} tokens · ${bucket.requests} 次请求`}
                    >
                      <div className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
                        <w.icon className="size-3.5" strokeWidth={1.9} />
                        {w.label}
                      </div>
                      <div className="mt-2 font-display text-[19px] font-semibold leading-none tracking-[-0.02em] tabular-nums">
                        {fmt(bucket.totalTokens)}
                      </div>
                      <div className="mt-1.5 flex items-center justify-between text-[10px] text-muted-foreground">
                        <span className="tabular-nums">{bucket.requests.toLocaleString()} 次</span>
                        <span className="tabular-nums">
                          {w.key === "all" ? "100%" : `${share.toFixed(share >= 10 ? 0 : 1)}%`}
                        </span>
                      </div>
                      {w.key !== "all" ? (
                        <div aria-hidden="true" className="mt-2 h-1 overflow-hidden rounded-full bg-border/60">
                          <div
                            className="h-full rounded-full bg-primary/70"
                            style={{ width: `${Math.min(100, share)}%` }}
                          />
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            </CardContent>
          </Card>

          <div className="grid grid-cols-2 gap-2.5 sm:gap-3 xl:grid-cols-4">
            <StatCard
              label="总请求"
              value={usage.totals.requests.toLocaleString()}
              icon={Activity}
              hint={`累计 · 成功率 ${successRate.toFixed(1)}%`}
            />
            <StatCard
              label="输入 Token"
              value={fmt(usage.totals.promptTokens)}
              icon={ArrowDownToLine}
              tone="sky"
              hint={`累计 · ${usage.totals.totalTokens ? ((usage.totals.promptTokens / usage.totals.totalTokens) * 100).toFixed(0) : 0}% 的 Token 占比`}
            />
            <StatCard
              label="输出 Token"
              value={fmt(usage.totals.completionTokens)}
              icon={ArrowUpFromLine}
              tone="brand"
              hint={`累计 · ${usage.totals.totalTokens ? ((usage.totals.completionTokens / usage.totals.totalTokens) * 100).toFixed(0) : 0}% 的 Token 占比`}
            />
            <StatCard
              label="失败请求"
              value={usage.totals.errors.toLocaleString()}
              icon={TriangleAlert}
              tone={usage.totals.errors > 0 ? "rose" : "neutral"}
              hint={usage.totals.errors > 0 ? "累计 · 查看最近请求详情" : "累计 · 没有失败请求"}
            />
          </div>

          <Card>
            <CardHeader className="flex-row items-center justify-between">
              <div>
                <CardTitle className="text-[13px]">每日趋势</CardTitle>
                <p className="mt-1 text-[11px] text-muted-foreground">近 30 日的输入与输出 Token 消耗（按自然日汇总）。</p>
              </div>
              <Badge variant="outline" className="h-6 text-[10.5px] font-normal">
                {daily.length} 天
              </Badge>
            </CardHeader>
            <CardContent>
              <div className="h-64">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={daily} margin={{ left: 0, right: 8, top: 4, bottom: 0 }}>
                    <defs>
                      <linearGradient id="gIn" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="var(--data-series-sky)" stopOpacity={0.28} />
                        <stop offset="100%" stopColor="var(--data-series-sky)" stopOpacity={0.01} />
                      </linearGradient>
                      <linearGradient id="gOut" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="var(--data-series-emerald)" stopOpacity={0.3} />
                        <stop offset="100%" stopColor="var(--data-series-emerald)" stopOpacity={0.01} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                    <XAxis dataKey="day" tick={{ fontSize: 10, fill: "var(--muted-foreground)" }} tickLine={false} axisLine={false} tickFormatter={(v: string) => v.slice(5)} />
                    <YAxis tick={{ fontSize: 10, fill: "var(--muted-foreground)" }} tickLine={false} axisLine={false} tickFormatter={fmt} width={44} />
                    <RTooltip contentStyle={tooltipStyle} labelStyle={{ color: "var(--muted-foreground)", fontSize: 10 }} />
                    <Legend wrapperStyle={{ fontSize: 11 }} iconType="circle" iconSize={7} />
                    <Area type="monotone" dataKey="promptTokens" name="输入 Token" stroke="var(--data-series-sky)" fill="url(#gIn)" strokeWidth={2} isAnimationActive={false} />
                    <Area type="monotone" dataKey="completionTokens" name="输出 Token" stroke="var(--data-series-emerald)" fill="url(#gOut)" strokeWidth={2} isAnimationActive={false} />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </CardContent>
          </Card>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle className="text-[13px]">按模型分布</CardTitle>
                <p className="text-[11px] text-muted-foreground">
                  最近 {usage.detailCount} 条请求明细
                  {usage.detailSince ? `（${usage.detailSince} 起）` : ""}
                </p>
              </CardHeader>
              <CardContent>
                <div className="h-56">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={byModel} layout="vertical" margin={{ left: 0, right: 12, top: 0, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" horizontal={false} />
                      <XAxis type="number" tick={{ fontSize: 10, fill: "var(--muted-foreground)" }} tickLine={false} axisLine={false} tickFormatter={fmt} />
                      <YAxis type="category" dataKey="name" tick={{ fontSize: 10, fill: "var(--muted-foreground)" }} tickLine={false} axisLine={false} width={90} />
                      <RTooltip contentStyle={tooltipStyle} cursor={{ fill: "var(--muted)", opacity: 0.4 }} />
                      <Bar dataKey="totalTokens" name="总 Token" radius={[0, 5, 5, 0]} barSize={14} isAnimationActive={false}>
                        {byModel.map((_, i) => <Cell key={i} fill={SERIES[i % SERIES.length]} />)}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-[13px]">按账号分布</CardTitle>
                <p className="text-[11px] text-muted-foreground">
                  最近 {usage.detailCount} 条请求明细
                  {usage.detailSince ? `（${usage.detailSince} 起）` : ""}
                </p>
              </CardHeader>
              <CardContent>
                <div className="h-56">
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie
                        data={usage.byAccount ?? []}
                        dataKey="totalTokens"
                        nameKey="name"
                        cx="50%"
                        cy="50%"
                        innerRadius={46}
                        outerRadius={74}
                        paddingAngle={2}
                        strokeWidth={0}
                        isAnimationActive={false}
                      >
                        {(usage.byAccount ?? []).map((_, i) => <Cell key={i} fill={SERIES[i % SERIES.length]} />)}
                      </Pie>
                      <RTooltip contentStyle={tooltipStyle} />
                      <Legend wrapperStyle={{ fontSize: 10.5 }} iconType="circle" iconSize={7} />
                    </PieChart>
                  </ResponsiveContainer>
                </div>
              </CardContent>
            </Card>
          </div>

          {byApi.length > 0 ? (
            <div className="grid gap-3 sm:grid-cols-3">
              {byApi.map((row) => (
                <div key={row.name} className="rounded-2xl border border-border/80 bg-card px-4 py-3.5 shadow-[0_1px_2px_oklch(0.2_0.02_255/4%)]">
                  <div className="flex items-center justify-between">
                    <div className="text-[11px] text-muted-foreground">
                      {row.name === "chat" ? "Chat Completions" : row.name === "responses" ? "Responses（Codex）" : row.name === "messages" ? "Messages（Claude Code）" : row.name}
                    </div>
                    <Badge variant="secondary" className="h-5 text-[10px] tabular-nums">{row.requests} 次</Badge>
                  </div>
                  <div className="mt-2 font-display text-lg font-semibold tabular-nums tracking-tight">{fmt(row.totalTokens)}</div>
                  <div className="mt-0.5 text-[10.5px] text-muted-foreground">tokens</div>
                </div>
              ))}
            </div>
          ) : null}

          <Card>
            <CardHeader>
              <CardTitle className="text-[13px]">最近请求</CardTitle>
              <p className="text-[11px] text-muted-foreground">最近 50 条反代请求记录。</p>
            </CardHeader>
            <CardContent>
              <div className="max-h-80 overflow-auto rounded-xl border border-border/70">
                <table className="w-full min-w-[720px] text-[11.5px]">
                  <thead className="sticky top-0 z-10 bg-card">
                    <tr className="border-b border-border/70 text-left text-[10.5px] text-muted-foreground">
                      <th className="px-4 py-2.5 font-medium">时间</th>
                      <th className="px-3 py-2.5 font-medium">版本</th>
                      <th className="px-3 py-2.5 font-medium">账号</th>
                      <th className="px-3 py-2.5 font-medium">模型</th>
                      <th className="px-3 py-2.5 font-medium">Tokens</th>
                      <th className="px-4 py-2.5 text-right font-medium">状态</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(usage.recent ?? []).map((r, i) => (
                      <tr key={i} className="border-b border-border/40 last:border-0 hover:bg-muted/25">
                        <td className="px-4 py-2 tabular-nums text-muted-foreground">
                          {new Date(r.ts).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}
                        </td>
                        <td className="px-3 py-2">
                          <Badge variant="secondary" className="h-5 text-[10px] font-normal">
                            {r.edition === "domestic" ? "国内" : "国际"}
                          </Badge>
                        </td>
                        <td className="max-w-[150px] truncate px-3 py-2">{r.accountName || "未知账号"}</td>
                        <td className="px-3 py-2 font-mono text-[10.5px]">{r.model}</td>
                        <td className="px-3 py-2 tabular-nums">{r.totalTokens.toLocaleString()}</td>
                        <td className="px-4 py-2 text-right">
                          {r.success ? (
                            <Badge variant="success" className="h-5 text-[10px]">成功</Badge>
                          ) : (
                            <Badge variant="destructive" className="h-5 text-[10px]" title={r.error}>失败</Badge>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
