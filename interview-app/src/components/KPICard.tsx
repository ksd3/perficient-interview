"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase";
import type { KPIConfig } from "@/lib/types";

function formatValue(value: number, format?: string): string {
  if (format === "currency") return `$${value.toLocaleString()}`;
  if (format === "percent") return `${value.toFixed(1)}%`;
  return value.toLocaleString();
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function applyFilter(query: any, filter: string) {
  if (!filter) return query;
  const inMatch = filter.match(/^(\w+)\.in\.\((.+)\)$/);
  if (inMatch) {
    const [, col, vals] = inMatch;
    return query.in(col, vals.split(",").map((v: string) => v.trim()));
  }
  const notIsMatch = filter.match(/^(\w+)\.not\.is\.null$/);
  if (notIsMatch) return query.not(notIsMatch[1], "is", null);
  const isMatch = filter.match(/^(\w+)\.is\.null$/);
  if (isMatch) return query.is(isMatch[1], null);
  const parts = filter.split(".");
  if (parts.length >= 3) {
    const col = parts[0];
    const op = parts[1];
    const val = parts.slice(2).join(".");
    const numVal = Number(val);
    const typedVal = !isNaN(numVal) && val !== "" ? numVal : val;
    switch (op) {
      case "eq": return query.eq(col, typedVal);
      case "neq": return query.neq(col, typedVal);
      case "gt": return query.gt(col, typedVal);
      case "gte": return query.gte(col, typedVal);
      case "lt": return query.lt(col, typedVal);
      case "lte": return query.lte(col, typedVal);
    }
  }
  return query;
}

// Vibrant gradient palette — each KPI gets a unique color
const GRADIENTS = [
  { bg: "from-blue-500/10 to-blue-600/5", text: "text-blue-700 dark:text-blue-400", icon: "bg-blue-500/15 text-blue-600" },
  { bg: "from-purple-500/10 to-purple-600/5", text: "text-purple-700 dark:text-purple-400", icon: "bg-purple-500/15 text-purple-600" },
  { bg: "from-emerald-500/10 to-emerald-600/5", text: "text-emerald-700 dark:text-emerald-400", icon: "bg-emerald-500/15 text-emerald-600" },
  { bg: "from-amber-500/10 to-amber-600/5", text: "text-amber-700 dark:text-amber-400", icon: "bg-amber-500/15 text-amber-600" },
  { bg: "from-rose-500/10 to-rose-600/5", text: "text-rose-700 dark:text-rose-400", icon: "bg-rose-500/15 text-rose-600" },
  { bg: "from-cyan-500/10 to-cyan-600/5", text: "text-cyan-700 dark:text-cyan-400", icon: "bg-cyan-500/15 text-cyan-600" },
];

interface TrendInfo {
  direction: "up" | "down" | "flat";
  recent: number;
}

export function KPICard({ config, refreshKey = 0, index = 0 }: { config: KPIConfig; refreshKey?: number; index?: number }) {
  const [value, setValue] = useState<number | null>(null);
  const [trend, setTrend] = useState<TrendInfo | null>(null);
  const supabase = createClient();
  const palette = GRADIENTS[index % GRADIENTS.length];

  useEffect(() => {
    async function fetchData() {
      if (config.aggregate === "count") {
        let query = supabase.from(config.table).select("*", { count: "exact", head: true });
        query = applyFilter(query, config.filter || "");
        const { count } = await query;
        setValue(count ?? 0);

        try {
          const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
          let recentQuery = supabase.from(config.table).select("*", { count: "exact", head: true }).gte("created_at", weekAgo);
          recentQuery = applyFilter(recentQuery, config.filter || "");
          const { count: recentCount } = await recentQuery;
          if (recentCount !== null && (count ?? 0) > 0) {
            setTrend({ direction: recentCount > 0 ? "up" : "flat", recent: recentCount });
          }
        } catch { /* trend is optional */ }

      } else if (config.aggregate === "count_ratio") {
        const totalQuery = supabase.from(config.table).select("*", { count: "exact", head: true });
        const { count: total } = await totalQuery;
        let filteredQuery = supabase.from(config.table).select("*", { count: "exact", head: true });
        filteredQuery = applyFilter(filteredQuery, config.filter || "");
        const { count: filtered } = await filteredQuery;
        if (total && total > 0) {
          setValue(((filtered ?? 0) / total) * 100);
        } else {
          setValue(0);
        }
      } else {
        let query = supabase.from(config.table).select("*");
        query = applyFilter(query, config.filter || "");
        const { data } = await query;
        if (data && config.field) {
          const rows = data as unknown as Record<string, unknown>[];
          const nums = rows.map((r) => Number(r[config.field!])).filter((n) => !isNaN(n));
          if (config.aggregate === "sum") {
            setValue(nums.reduce((a, b) => a + b, 0));
          }
          if (config.aggregate === "avg") {
            const avg = nums.length > 0 ? nums.reduce((a, b) => a + b, 0) / nums.length : 0;
            setValue(avg);
            if (nums.length >= 4) {
              const mid = Math.floor(nums.length / 2);
              const olderAvg = nums.slice(0, mid).reduce((a, b) => a + b, 0) / mid;
              const newerAvg = nums.slice(mid).reduce((a, b) => a + b, 0) / (nums.length - mid);
              const pctChange = olderAvg > 0 ? ((newerAvg - olderAvg) / olderAvg) * 100 : 0;
              if (Math.abs(pctChange) > 2) {
                setTrend({ direction: pctChange > 0 ? "up" : "down", recent: Math.round(Math.abs(pctChange)) });
              }
            }
          }
        }
      }
    }
    fetchData();
  }, [config, refreshKey]);

  return (
    <div className={`relative overflow-hidden rounded-2xl bg-gradient-to-br ${palette.bg} border border-border/30 p-5 shadow-sm`}>
      {/* Decorative circle */}
      <div className={`absolute -top-4 -right-4 h-20 w-20 rounded-full ${palette.icon} opacity-30`} />

      <div className="relative">
        <p className="text-[11px] font-semibold text-muted-foreground/80 uppercase tracking-widest truncate mb-2">
          {config.label}
        </p>
        <div className="flex items-end gap-2">
          <p className={`text-2xl sm:text-3xl font-bold tracking-tight ${palette.text} truncate`}>
            {value !== null ? formatValue(value, config.format) : (
              <span className="text-muted-foreground/30">...</span>
            )}
          </p>
          {trend && trend.direction !== "flat" && (
            <span className={`flex items-center gap-0.5 text-xs font-semibold mb-1 ${
              trend.direction === "up" ? "text-emerald-600" : "text-red-500"
            }`}>
              {trend.direction === "up" ? "\u2191" : "\u2193"}
              {trend.recent > 0 && (
                <span>{config.aggregate === "count" ? `+${trend.recent}` : `${trend.recent}%`}</span>
              )}
            </span>
          )}
        </div>
        <p className="text-[9px] text-muted-foreground/40 mt-2 truncate">
          Source: {config.table.replace(/_/g, " ")}
        </p>
      </div>
    </div>
  );
}
