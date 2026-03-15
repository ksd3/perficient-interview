"use client";

import { useEffect, useState, useCallback } from "react";
import type { AppConfig, TableConfig, OutputSection } from "@/lib/types";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { KPICard } from "@/components/KPICard";
import { DynamicChart } from "@/components/DynamicChart";
import { DynamicTable } from "@/components/DynamicTable";
import { createClient } from "@/lib/supabase";

interface Insight {
  type: "critical" | "warning" | "info";
  message: string;
}

interface PriorityAction {
  id: string;
  label: string;
  reason: string;
  score: number;
}

export function DashboardPanel({ config }: { config: AppConfig }) {
  const [refreshKey, setRefreshKey] = useState(0);
  const [autoTableConfig, setAutoTableConfig] = useState<TableConfig | null>(null);
  const [insights, setInsights] = useState<Insight[]>([]);
  const [priorityActions, setPriorityActions] = useState<PriorityAction[]>([]);
  const supabase = createClient();

  const explicitTableConfig: TableConfig | null =
    config.layout_overrides && "table_config" in config.layout_overrides
      ? (config.layout_overrides.table_config as TableConfig)
      : null;

  const refresh = useCallback(() => {
    setRefreshKey((k) => k + 1);
  }, []);

  useEffect(() => {
    const channel = supabase
      .channel("dashboard-realtime")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "dashboard_updates" },
        () => refresh()
      )
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [refresh]);

  // Auto-discover table + generate data-driven insights
  useEffect(() => {
    async function init() {
      const { data: ac } = await supabase
        .from("agent_config")
        .select("source_tables")
        .order("created_at", { ascending: false })
        .limit(1)
        .single();

      if (!ac?.source_tables?.length) return;
      const sourceTables: string[] = ac.source_tables;
      const primaryTable = sourceTables[0];

      // Auto-discover table config
      if (!explicitTableConfig) {
        const { data: sampleRows } = await supabase.from(primaryTable).select("*").limit(1);
        if (sampleRows?.length) {
          const skipCols = new Set(["id", "created_at", "embedding", "stage"]);
          const columns = Object.keys(sampleRows[0])
            .filter((c) => !skipCols.has(c))
            .slice(0, 5);
          setAutoTableConfig({ source_table: primaryTable, columns });
        }
      }

      // Generate data-driven insights from pipeline_results
      const { data: pipelineResults } = await supabase
        .from("pipeline_results")
        .select("item_id, score, sections")
        .eq("item_table", primaryTable);

      if (pipelineResults && pipelineResults.length > 0) {
        const newInsights: Insight[] = [];
        const criticalItems = pipelineResults.filter((pr) => (pr.score ?? 100) < 50);
        const warningItems = pipelineResults.filter((pr) => {
          const s = pr.score ?? 100;
          return s >= 50 && s < 80;
        });

        if (criticalItems.length > 0) {
          // Find the most common critical rule failure
          const failLabels: Record<string, number> = {};
          for (const pr of criticalItems) {
            const checklist = (pr.sections as OutputSection[])?.find((s) => s.type === "checklist");
            const items = checklist ? (checklist.data as { items?: Array<{ passed: boolean; severity: string; label: string }> })?.items || [] : [];
            for (const item of items) {
              if (!item.passed && item.severity === "critical") {
                failLabels[item.label] = (failLabels[item.label] || 0) + 1;
              }
            }
          }
          const topFail = Object.entries(failLabels).sort((a, b) => b[1] - a[1])[0];
          newInsights.push({
            type: "critical",
            message: `${criticalItems.length} record${criticalItems.length > 1 ? "s" : ""} flagged as high risk${topFail ? ` — most common: ${topFail[0]}` : ""}`,
          });
        }

        if (warningItems.length > 0) {
          newInsights.push({
            type: "warning",
            message: `${warningItems.length} record${warningItems.length > 1 ? "s" : ""} need${warningItems.length === 1 ? "s" : ""} review — moderate risk detected`,
          });
        }

        const goodItems = pipelineResults.filter((pr) => (pr.score ?? 100) >= 80);
        if (goodItems.length > 0 && criticalItems.length === 0) {
          newInsights.push({
            type: "info",
            message: `${goodItems.length} of ${pipelineResults.length} records are in good standing`,
          });
        }

        setInsights(newInsights);

        // Build priority actions: specific records that need attention
        // Match pipeline results to actual records
        const urgentPRs = pipelineResults
          .filter((pr) => (pr.score ?? 100) < 80 && pr.item_id)
          .sort((a, b) => (a.score ?? 100) - (b.score ?? 100))
          .slice(0, 5);

        if (urgentPRs.length > 0) {
          const { data: records } = await supabase
            .from(primaryTable)
            .select("*")
            .in("id", urgentPRs.map((pr) => pr.item_id));

          if (records) {
            const actions: PriorityAction[] = urgentPRs.map((pr) => {
              const record = records.find((r) => r.id === pr.item_id);
              // Find a label from the record — skip UUIDs and system fields
              const isUUID = (s: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-/.test(s);
              const label = record
                ? String(Object.entries(record).find(([k, v]) => !["id", "created_at", "stage", "embedding", "notes"].includes(k) && typeof v === "string" && v.length > 2 && v.length < 60 && !isUUID(v))?.[1] || pr.item_id)
                : String(pr.item_id);
              // Find top issue from checklist
              const checklist = (pr.sections as OutputSection[])?.find((s) => s.type === "checklist");
              const items = checklist ? (checklist.data as { items?: Array<{ passed: boolean; severity: string; label: string }> })?.items || [] : [];
              const topIssue = items.find((i) => !i.passed)?.label || "Review needed";

              return {
                id: String(pr.item_id),
                label,
                reason: topIssue,
                score: pr.score ?? 100,
              };
            });
            setPriorityActions(actions);
          }
        }
      }
    }
    init();
  }, [explicitTableConfig]);

  const tableConfig = explicitTableConfig || autoTableConfig;

  const kpiCount = config.kpi_config.length;
  const kpiCols = kpiCount <= 2
    ? "grid-cols-1 sm:grid-cols-2"
    : kpiCount <= 3
      ? "grid-cols-1 sm:grid-cols-3"
      : "grid-cols-2 lg:grid-cols-4";

  // Extract images from layout_overrides
  const overrides = config.layout_overrides as Record<string, unknown> | undefined;
  const images = overrides?.images as Record<string, string> | undefined;
  const heroImage = images?.image_0;
  // Also check if images were stored inside table_config (in case layout_overrides was structured differently)
  const altImages = !images && overrides ? Object.values(overrides).find(
    (v) => typeof v === "object" && v !== null && "image_0" in (v as Record<string, unknown>)
  ) as Record<string, string> | undefined : undefined;
  const finalHeroImage = heroImage || altImages?.image_0;

  return (
    <div className="flex flex-col gap-6">
      {/* Hero image */}
      {finalHeroImage && (
        <div className="relative h-44 rounded-2xl overflow-hidden">
          <img
            src={finalHeroImage}
            alt=""
            className="absolute inset-0 w-full h-full object-cover"
          />
          <div className="absolute inset-0 bg-gradient-to-t from-background/90 via-background/40 to-transparent" />
          <div className="absolute bottom-5 left-6">
            <h2 className="text-xl font-bold text-foreground">{config.title}</h2>
            {config.description && (
              <p className="text-sm text-foreground/70 mt-0.5">{config.description}</p>
            )}
          </div>
          {(images?.image_0_credit || altImages?.image_0_credit) && (
            <span className="absolute bottom-2 right-3 text-[9px] text-foreground/30">
              Photo: {images?.image_0_credit || altImages?.image_0_credit}
            </span>
          )}
        </div>
      )}

      {/* Smart Insights Banner */}
      {insights.length > 0 && (
        <div className="flex flex-col gap-2.5">
          {insights.map((insight, i) => (
            <div
              key={i}
              className={`flex items-center gap-4 rounded-2xl px-5 py-4 ${
                insight.type === "critical"
                  ? "bg-gradient-to-r from-red-50 to-red-50/30 border border-red-200/60 text-red-800 dark:from-red-950/40 dark:to-red-950/10 dark:border-red-900/40 dark:text-red-300"
                  : insight.type === "warning"
                    ? "bg-gradient-to-r from-amber-50 to-amber-50/30 border border-amber-200/60 text-amber-800 dark:from-amber-950/40 dark:to-amber-950/10 dark:border-amber-900/40 dark:text-amber-300"
                    : "bg-gradient-to-r from-emerald-50 to-emerald-50/30 border border-emerald-200/60 text-emerald-800 dark:from-emerald-950/40 dark:to-emerald-950/10 dark:border-emerald-900/40 dark:text-emerald-300"
              }`}
            >
              <span className={`flex h-8 w-8 items-center justify-center rounded-xl shrink-0 text-sm ${
                insight.type === "critical" ? "bg-red-500/15 text-red-600" :
                insight.type === "warning" ? "bg-amber-500/15 text-amber-600" : "bg-emerald-500/15 text-emerald-600"
              }`}>
                {insight.type === "critical" ? "!" : insight.type === "warning" ? "?" : "\u2713"}
              </span>
              <span className="font-medium text-sm">{insight.message}</span>
            </div>
          ))}
        </div>
      )}

      {/* Priority Actions — what to do TODAY */}
      {priorityActions.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-semibold">Priority Actions</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex flex-col gap-2">
              {priorityActions.map((action) => (
                <button
                  key={action.id}
                  onClick={() => {
                    // Scroll to table and select this record
                    const table = document.querySelector("[data-slot='card']");
                    if (table) table.scrollIntoView({ behavior: "smooth" });
                  }}
                  className={`flex items-center gap-3 rounded-xl px-4 py-3 text-left transition-all duration-200 hover:scale-[1.01] group ${
                    action.score < 50 ? "bg-red-50/50 dark:bg-red-950/20" : "bg-amber-50/50 dark:bg-amber-950/20"
                  }`}
                >
                  <span className={`flex h-8 w-8 items-center justify-center rounded-lg shrink-0 text-xs font-bold ${
                    action.score < 50 ? "bg-red-500/15 text-red-600" : "bg-amber-500/15 text-amber-600"
                  }`}>
                    {action.score}
                  </span>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold truncate group-hover:text-primary transition-colors">{action.label}</p>
                    <p className="text-xs text-muted-foreground/60 truncate">{action.reason}</p>
                  </div>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-muted-foreground/30 shrink-0">
                    <polyline points="9 18 15 12 9 6" />
                  </svg>
                </button>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* KPI Row */}
      {config.kpi_config.length > 0 && (
        <div className={`grid gap-5 ${kpiCols}`}>
          {config.kpi_config.map((kpi, i) => (
            <KPICard key={i} config={kpi} refreshKey={refreshKey} index={i} />
          ))}
        </div>
      )}

      {/* Data Table */}
      {tableConfig && <DynamicTable config={tableConfig} refreshKey={refreshKey} />}

      {/* Charts */}
      {config.chart_config.length > 0 && (
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
          {config.chart_config.map((chart, i) => (
            <DynamicChart key={i} config={chart} refreshKey={refreshKey} />
          ))}
        </div>
      )}
    </div>
  );
}
