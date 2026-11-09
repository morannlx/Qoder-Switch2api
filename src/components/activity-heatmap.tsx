import { useMemo } from "react";

import { cn } from "@/lib/utils";

/**
 * 活动热力图：一周七行、按周分列的日历格。
 *
 * 参考 GitHub contribution graph 的读法：列是周、行是星期几、颜色深浅是当天的
 * Token 消耗。空白格子是「那天没有请求」，不是「那天消耗为 0」——两者在语义上
 * 不同，所以无数据的日子不上色。
 *
 * 尺寸交给 CSS grid 自适应：列宽 = 可用宽度 / 周数，格子用 aspect-ratio 保持方形。
 * 写死 px 会让热力图在宽屏只占左半边、右边一片空白。
 *
 * 分位阈值按当前数据的最大值动态算，避免固定档位在数据量差异大时全部同色。
 */

export interface HeatmapDay {
  day: string; // YYYY-MM-DD
  tokens: number;
  requests: number;
}

const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"];
const MONTH_LABELS = ["1月", "2月", "3月", "4月", "5月", "6月", "7月", "8月", "9月", "10月", "11月", "12月"];

/** 把 YYYY-MM-DD 解析成本地日期（避免 new Date(str) 按 UTC 解析导致的错位） */
function dayKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/** Token 数以百万计来读：582388930 → 582.4M。热力图 tooltip 用这个而不是千分位长串 */
function fmtMillions(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

/** 颜色档位：0 = 无数据（不上色），1..4 由浅到深 */
function levelOf(tokens: number, max: number): 0 | 1 | 2 | 3 | 4 {
  if (!tokens || tokens <= 0) return 0;
  if (max <= 0) return 1;
  const ratio = tokens / max;
  if (ratio <= 0.15) return 1;
  if (ratio <= 0.4) return 2;
  if (ratio <= 0.7) return 3;
  return 4;
}

const LEVEL_CLASS: Record<number, string> = {
  0: "bg-muted/50 dark:bg-muted/35",
  1: "bg-primary/20 dark:bg-primary/25",
  2: "bg-primary/40 dark:bg-primary/45",
  3: "bg-primary/65 dark:bg-primary/70",
  4: "bg-primary/90 dark:bg-primary/95",
};

export function ActivityHeatmap({
  data,
  days = 365,
  className,
}: {
  data: HeatmapDay[];
  /** 回溯天数（含今天） */
  days?: number;
  className?: string;
}) {
  const { columns, monthMarks, maxTokens } = useMemo(() => {
    const byDay = new Map(data.map((d) => [d.day, d]));
    const max = data.reduce((m, d) => Math.max(m, d.tokens), 0);

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const windowStart = new Date(today);
    windowStart.setDate(windowStart.getDate() - (days - 1));
    // 从当周的周日开始，让每列都是完整的一周
    const gridStart = new Date(windowStart);
    gridStart.setDate(gridStart.getDate() - gridStart.getDay());

    const cols: (HeatmapDay | null)[][] = [];
    const marks: (string | null)[] = [];
    const cursor = new Date(gridStart);
    let lastMonth = -1;

    while (cursor <= today) {
      const cells: (HeatmapDay | null)[] = [];
      for (let i = 0; i < 7; i += 1) {
        // 超出回溯窗口的格子（起始周的前几天）留空
        const inWindow = cursor >= windowStart && cursor <= today;
        cells.push(inWindow ? byDay.get(dayKey(cursor)) || null : null);
        if (i === 0 && inWindow) {
          const m = cursor.getMonth();
          // 每月第一次出现在列首时打标；月初不在列首的日子由下一列接上
          if (m !== lastMonth) {
            marks.push(MONTH_LABELS[m]);
            lastMonth = m;
          } else {
            marks.push(null);
          }
        } else if (i === 0) {
          marks.push(null);
        }
        cursor.setDate(cursor.getDate() + 1);
      }
      cols.push(cells);
    }

    return { columns: cols, monthMarks: marks, maxTokens: max };
  }, [data, days]);

  const colCount = columns.length;
  const gridStyle = {
    display: "grid",
    gridAutoFlow: "column" as const,
    gridTemplateColumns: `repeat(${colCount}, minmax(0, 1fr))`,
    gridTemplateRows: "repeat(7, auto)",
    gap: "3px",
  };
  // 格子高度固定、宽度随列宽走：53 列铺满容器时列宽约 12-16px，接近方形；
  // 用 aspect-square 会按列宽算高度，容器一窄格子就扁掉
  const cellHeight = 13;

  return (
    <div className={cn("min-w-0", className)}>
      {/* 53 周在窄屏塞不下：给格子一个最小宽度并允许横向滚动，
          而不是把列压到 6px 以下（那时格子糊成一片、看不出深浅） */}
      <div className="overflow-x-auto pb-1">
        <div className="min-w-[560px]">
          {/* 月份刻度：与格子同列宽，文本允许溢出到右侧空白（不换行） */}
          <div className="flex gap-2">
            <div className="w-3 shrink-0" />
            <div
              className="min-w-0 flex-1"
              style={{ ...gridStyle, gridAutoFlow: "row", gridTemplateRows: "auto" }}
            >
              {monthMarks.map((label, i) => (
                <div key={i} className="overflow-visible">
                  <span className="block whitespace-nowrap text-[9px] leading-none text-muted-foreground/80">
                    {label ?? ""}
                  </span>
                </div>
              ))}
            </div>
          </div>

          <div className="mt-1 flex gap-2">
            {/* 星期刻度：只标一/三/五，和参考图一致 */}
            <div className="flex w-3 shrink-0 flex-col gap-[3px]">
              {WEEKDAYS.map((w) => (
                <div key={w} className="flex flex-1 items-center text-[9px] leading-none text-muted-foreground/70">
                  {w === "一" || w === "三" || w === "五" ? w : ""}
                </div>
              ))}
            </div>

            <div className="min-w-0 flex-1" style={gridStyle}>
              {columns.map((cells, col) =>
                cells.map((cell, row) => {
                  const level = cell ? levelOf(cell.tokens, maxTokens) : 0;
                  return (
                    <div
                      key={`${col}-${row}`}
                      title={
                        cell
                          ? `${cell.day} · ${fmtMillions(cell.tokens)} tokens · ${cell.requests} 次请求`
                          : undefined
                      }
                      className={cn(
                        "min-w-[6px] rounded-[2px] transition-colors",
                        LEVEL_CLASS[level],
                        cell ? "hover:ring-1 hover:ring-primary/60" : "",
                      )}
                      style={{ height: cellHeight }}
                    />
                  );
                }),
              )}
            </div>
          </div>
        </div>
      </div>

      {/* 图例 */}
      <div className="mt-2 flex items-center justify-end gap-1 text-[10px] text-muted-foreground">
        <span className="mr-1">少</span>
        {[0, 1, 2, 3, 4].map((lv) => (
          <span key={lv} className={cn("size-[9px] rounded-[2px]", LEVEL_CLASS[lv])} />
        ))}
        <span className="ml-1">多</span>
      </div>
    </div>
  );
}
