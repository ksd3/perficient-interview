"use client";

import { useEffect, useState, useCallback } from "react";
import type { AppConfig, WorkflowConfig, WorkflowStage, OutputSection } from "@/lib/types";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { SectionRenderer } from "@/components/sections/SectionRenderer";
import { createClient } from "@/lib/supabase";
import { ProcessingIndicator } from "@/components/ui/processing-indicator";

interface WorkflowItem {
  id: string;
  stage: string;
  [key: string]: unknown;
}

interface ActivityEntry {
  id: string;
  action: string;
  timestamp: string;
}

interface PipelineResult {
  id: string;
  sections: OutputSection[];
  score: number | null;
  created_at: string;
}

function ConfirmDialog({
  message,
  onConfirm,
  onCancel,
}: {
  message: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
      <Card className="w-[420px] shadow-2xl">
        <CardContent className="flex flex-col gap-5 pt-6">
          <p className="text-sm">{message}</p>
          <div className="flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={onCancel}>
              Cancel
            </Button>
            <Button variant="destructive" size="sm" onClick={onConfirm}>
              Confirm
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function ItemCard({
  item,
  stage,
  workflowConfig,
  labelField,
  onAction,
}: {
  item: WorkflowItem;
  stage: WorkflowStage | undefined;
  workflowConfig: WorkflowConfig;
  labelField: string;
  onAction: () => void;
}) {
  const [acting, setActing] = useState(false);
  const [confirmAction, setConfirmAction] = useState<{ id: string; label: string; next_stage: string } | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [pipelineResult, setPipelineResult] = useState<PipelineResult | null>(null);
  const [loadingResults, setLoadingResults] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const supabase = createClient();

  // Find a display label from the item
  const displayLabel = String(item[labelField] || item.id).slice(0, 60);

  // Detail fields: everything except id, stage, created_at
  const detailFields = Object.entries(item).filter(
    ([k]) => !["id", "stage", "created_at"].includes(k)
  );

  async function fetchPipelineResult() {
    setLoadingResults(true);
    const { data } = await supabase
      .from("pipeline_results")
      .select("*")
      .eq("item_id", item.id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (data) {
      setPipelineResult(data as unknown as PipelineResult);
    }
    setLoadingResults(false);
    return data;
  }

  async function toggleExpand() {
    const next = !expanded;
    setExpanded(next);
    if (next && !pipelineResult && !loadingResults) {
      await fetchPipelineResult();
    }
  }

  async function runAnalysis() {
    setAnalyzing(true);
    try {
      const res = await fetch("/api/analyze-item", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ item_id: item.id }),
      });
      if (res.ok) {
        const data = await res.json();
        if (data.sections) {
          setPipelineResult({
            id: "latest",
            sections: data.sections,
            score: data.sections.find((s: { type: string }) => s.type === "score")?.data?.score ?? null,
            created_at: new Date().toISOString(),
          });
        }
      }
    } finally {
      setAnalyzing(false);
    }
  }

  async function executeAction(actionId: string, nextStage: string) {
    setActing(true);
    try {
      const res = await fetch("/api/action", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          item_id: item.id,
          action_id: actionId,
          stage_id: item.stage,
        }),
      });
      if (res.ok) {
        onAction();
      }
    } finally {
      setActing(false);
      setConfirmAction(null);
    }
  }

  const stageLabel = stage?.label || item.stage;
  const isTerminal = stage?.terminal;
  const actions = stage?.actions || [];

  // Color for stage badge
  const stageIndex = workflowConfig.stages.findIndex((s) => s.id === item.stage);
  const badgeVariant: "default" | "secondary" | "destructive" | "outline" =
    isTerminal ? "default" :
    stageIndex === 0 ? "outline" :
    "secondary";

  return (
    <>
      <Card>
        <CardContent className="flex flex-col gap-0 pt-5">
          <div className="flex items-center justify-between gap-3">
            <button
              className="flex items-center gap-3 min-w-0 text-left"
              onClick={toggleExpand}
            >
              <span className={`text-xs text-muted-foreground/60 transition-transform duration-200 ${expanded ? "rotate-90" : ""}`}>▶</span>
              <div className="min-w-0">
                <p className="text-sm font-semibold truncate">{displayLabel}</p>
                <Badge variant={badgeVariant} className="mt-1">
                  {stageLabel}
                </Badge>
              </div>
            </button>
            {actions.length > 0 && (
              <div className="flex shrink-0 gap-2">
                {actions.map((action) => (
                  <Button
                    key={action.id}
                    size="sm"
                    variant={action.style === "destructive" ? "destructive" : "outline"}
                    disabled={acting}
                    onClick={() => {
                      if (action.confirm) {
                        setConfirmAction(action);
                      } else {
                        executeAction(action.id, action.next_stage);
                      }
                    }}
                  >
                    {action.label}
                  </Button>
                ))}
              </div>
            )}
          </div>

          {/* Expanded detail view */}
          {expanded && (
            <div className="mt-3 border-t pt-3 flex flex-col gap-3">
              {/* Item fields */}
              <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
                {detailFields.map(([key, value]) => (
                  <div key={key} className="flex justify-between gap-2 py-0.5">
                    <span className="text-muted-foreground font-medium">
                      {key.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())}
                    </span>
                    <span className="text-right truncate max-w-[180px]">
                      {value === null || value === undefined ? "—" : String(value)}
                    </span>
                  </div>
                ))}
              </div>

              {/* Pipeline results */}
              {loadingResults && (
                <p className="text-xs text-muted-foreground">Loading analysis...</p>
              )}
              {pipelineResult && (
                <div className="mt-2">
                  <div className="flex items-center justify-between mb-2">
                    <p className="text-xs font-medium text-muted-foreground">Pipeline Analysis</p>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={analyzing}
                      onClick={runAnalysis}
                    >
                      {analyzing ? "Re-analyzing..." : "Re-analyze"}
                    </Button>
                  </div>
                  <SectionRenderer sections={pipelineResult.sections} />
                </div>
              )}
              {!loadingResults && !pipelineResult && expanded && (
                <div className="flex items-center gap-3">
                  <p className="text-xs text-muted-foreground italic">No pipeline analysis yet.</p>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={analyzing}
                    onClick={runAnalysis}
                  >
                    {analyzing ? "Analyzing..." : "Run Analysis"}
                  </Button>
                  {analyzing && <ProcessingIndicator variant="analyze" />}
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {confirmAction && (
        <ConfirmDialog
          message={`Are you sure you want to "${confirmAction.label}" this item?`}
          onConfirm={() => executeAction(confirmAction.id, confirmAction.next_stage)}
          onCancel={() => setConfirmAction(null)}
        />
      )}
    </>
  );
}

export function WorkflowPanel({ config }: { config: AppConfig }) {
  const [items, setItems] = useState<WorkflowItem[]>([]);
  const [activity, setActivity] = useState<ActivityEntry[]>([]);
  const [agentConfig, setAgentConfig] = useState<{ workflow_config?: WorkflowConfig } | null>(null);
  const [stageFilter, setStageFilter] = useState<string | null>(null);
  const supabase = createClient();

  const workflowConfig = agentConfig?.workflow_config || null;

  const fetchAll = useCallback(async () => {
    // Fetch agent_config for workflow_config
    const { data: ac } = await supabase
      .from("agent_config")
      .select("workflow_config")
      .order("created_at", { ascending: false })
      .limit(1)
      .single();
    if (ac) setAgentConfig(ac as { workflow_config?: WorkflowConfig });

    const wc = ac?.workflow_config as WorkflowConfig | undefined;
    if (!wc?.item_table) return;

    // Fetch items from the workflow's item table
    const { data: rows } = await supabase
      .from(wc.item_table)
      .select("*")
      .order("created_at", { ascending: false })
      .limit(50);
    if (rows) setItems(rows as WorkflowItem[]);

    // Fetch activity log
    const { data: logs } = await supabase
      .from("activity_log")
      .select("*")
      .order("timestamp", { ascending: false })
      .limit(20);
    if (logs) setActivity(logs as unknown as ActivityEntry[]);
  }, []);

  useEffect(() => {
    fetchAll();

    const channel = supabase
      .channel("workflow-updates")
      .on("postgres_changes", { event: "*", schema: "public", table: "dashboard_updates" }, () => fetchAll())
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [fetchAll]);

  // If no workflow_config yet, fall back to legacy display
  if (!workflowConfig) {
    return (
      <p className="text-center text-sm text-muted-foreground py-8">
        No workflow configuration found.
      </p>
    );
  }

  // Build a stage lookup
  const stageMap = new Map(workflowConfig.stages.map((s) => [s.id, s]));

  // Try to find a good label field from the first item
  const labelField = items.length > 0
    ? Object.keys(items[0]).find((k) =>
        !["id", "stage", "created_at"].includes(k) && typeof items[0][k] === "string"
      ) || "id"
    : "id";

  // Summary counts
  const stageCounts = new Map<string, number>();
  for (const item of items) {
    stageCounts.set(item.stage, (stageCounts.get(item.stage) || 0) + 1);
  }

  return (
    <div className="flex flex-col gap-5">
      {/* Stage filter pills */}
      <div className="flex flex-wrap gap-2">
        <button
          onClick={() => setStageFilter(null)}
          className={`flex items-center gap-2 rounded-full px-4 py-1.5 text-xs font-semibold transition-all duration-200 ${
            stageFilter === null
              ? "bg-primary text-primary-foreground shadow-sm shadow-primary/20"
              : "bg-card border border-border/40 text-muted-foreground hover:text-foreground hover:border-border"
          }`}
        >
          All
          <span className={`flex h-4 min-w-4 items-center justify-center rounded-full px-1.5 text-[10px] font-bold ${
            stageFilter === null ? "bg-primary-foreground/20 text-primary-foreground" : "bg-muted text-muted-foreground"
          }`}>
            {items.length}
          </span>
        </button>
        {workflowConfig.stages.map((stage) => {
          const count = stageCounts.get(stage.id) || 0;
          const isActive = stageFilter === stage.id;
          return (
            <button
              key={stage.id}
              onClick={() => setStageFilter(isActive ? null : stage.id)}
              className={`flex items-center gap-2 rounded-full px-4 py-1.5 text-xs font-semibold transition-all duration-200 ${
                isActive
                  ? "bg-primary text-primary-foreground shadow-sm shadow-primary/20"
                  : "bg-card border border-border/40 text-muted-foreground hover:text-foreground hover:border-border"
              }`}
            >
              {stage.label}
              <span className={`flex h-4 min-w-4 items-center justify-center rounded-full px-1.5 text-[10px] font-bold ${
                isActive ? "bg-primary-foreground/20 text-primary-foreground" : "bg-muted text-muted-foreground"
              }`}>
                {count}
              </span>
            </button>
          );
        })}
      </div>

      {/* Items list — filtered by selected stage */}
      <div className="flex flex-col gap-3.5">
        {items.length === 0 && (
          <p className="text-center text-sm text-muted-foreground py-8">
            No items yet.
          </p>
        )}
        {(stageFilter ? items.filter((i) => i.stage === stageFilter) : items).map((item) => (
          <ItemCard
            key={item.id}
            item={item}
            stage={stageMap.get(item.stage)}
            workflowConfig={workflowConfig}
            labelField={labelField}
            onAction={fetchAll}
          />
        ))}
      </div>

      {/* Activity Log */}
      {activity.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium">Activity Log</CardTitle>
          </CardHeader>
          <CardContent>
            <ScrollArea className="h-[200px]">
              <div className="flex flex-col gap-2">
                {activity.map((entry) => (
                  <div key={entry.id} className="flex justify-between text-xs">
                    <span>{entry.action}</span>
                    <span className="text-muted-foreground">
                      {new Date(entry.timestamp).toLocaleTimeString()}
                    </span>
                  </div>
                ))}
              </div>
            </ScrollArea>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
