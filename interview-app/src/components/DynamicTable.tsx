"use client";

import { useEffect, useState, useCallback } from "react";
import { setFocusContext } from "@/lib/focus-context";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { SectionRenderer } from "@/components/sections/SectionRenderer";
import { ProcessingIndicator } from "@/components/ui/processing-indicator";
import { createClient } from "@/lib/supabase";
import type { TableConfig, OutputSection } from "@/lib/types";

function formatHeader(col: string) {
  return col.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function formatCell(value: unknown): string {
  if (value === null || value === undefined) return "\u2014";
  if (typeof value === "number") {
    if (value > 10000) return value.toLocaleString();
    return value.toLocaleString();
  }
  if (typeof value === "boolean") return value ? "Yes" : "No";
  const s = String(value);
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
    return new Date(s).toLocaleDateString();
  }
  return s.length > 60 ? s.slice(0, 57) + "..." : s;
}

interface RowCache {
  relatedData: Record<string, Record<string, unknown>[]>;
  sections: OutputSection[] | null;
  relatedLoaded: boolean;
  error: string | null;
}

// ─── Detail Panel (right side) ───────────────────────────────────────────────

function DetailPanel({
  row,
  tableName,
  columns,
  cache,
  onCacheUpdate,
  actionLabel,
  onClose,
}: {
  row: Record<string, unknown>;
  tableName: string;
  columns: string[];
  cache: RowCache;
  onCacheUpdate: (update: Partial<RowCache>) => void;
  actionLabel: string;
  onClose: () => void;
}) {
  const [analyzing, setAnalyzing] = useState(false);
  const [loadingRelated, setLoadingRelated] = useState(!cache.relatedLoaded);
  const [note, setNote] = useState("");
  const [savingNote, setSavingNote] = useState(false);
  const [durationMs, setDurationMs] = useState<number | null>(null);
  const supabase = createClient();

  // Set focus context
  useEffect(() => {
    setFocusContext({
      tableName,
      record: row,
      relatedData: cache.relatedData,
      analysisSummary: cache.sections
        ? cache.sections.filter((s) => s.type === "text").map((s) => (s.data as { content?: string }).content || "").join("\n")
        : undefined,
    });
    return () => setFocusContext(null);
  }, [row, tableName, cache.relatedData, cache.sections]);

  // Fetch related data
  useEffect(() => {
    if (cache.relatedLoaded) return;
    async function fetchRelated() {
      const { data: ac } = await supabase
        .from("agent_config")
        .select("source_tables")
        .order("created_at", { ascending: false })
        .limit(1)
        .single();
      if (!ac?.source_tables) {
        onCacheUpdate({ relatedLoaded: true });
        setLoadingRelated(false);
        return;
      }
      const sourceTables: string[] = ac.source_tables;
      const rowId = String(row.id);
      const related: Record<string, Record<string, unknown>[]> = {};
      const singularTable = tableName.replace(/s$/, "");
      const fkCandidates = [`${singularTable}_id`, `${tableName}_id`];
      for (const otherTable of sourceTables) {
        if (otherTable === tableName) continue;
        for (const fk of fkCandidates) {
          try {
            const { data } = await supabase.from(otherTable).select("*").eq(fk, rowId).limit(20);
            if (data && data.length > 0) { related[otherTable] = data; break; }
          } catch { /* FK doesn't exist */ }
        }
      }
      onCacheUpdate({ relatedData: related, relatedLoaded: true });
      setLoadingRelated(false);
    }
    fetchRelated();
  }, [cache.relatedLoaded]);

  async function runAnalysis() {
    setAnalyzing(true);
    setDurationMs(null);
    onCacheUpdate({ error: null });
    const start = Date.now();
    try {
      const res = await fetch("/api/analyze-item", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ item_id: row.id, table_name: tableName }),
      });
      const data = await res.json();
      if (res.ok && data.sections) {
        onCacheUpdate({ sections: data.sections });
        setDurationMs(data.metadata?.duration_ms || (Date.now() - start));
      } else {
        onCacheUpdate({ error: "Something went wrong. Please try again." });
        console.error("Analysis error:", data.error, res.status);
      }
    } catch (e) {
      onCacheUpdate({ error: "Could not connect. Please check your connection and try again." });
      console.error("Analysis error:", e);
    } finally {
      setAnalyzing(false);
    }
  }

  async function saveNote() {
    if (!note.trim()) return;
    setSavingNote(true);
    try {
      // Append note to the record (add/update a notes column)
      const existing = String(row.notes || "");
      const timestamp = new Date().toLocaleDateString();
      const newNotes = existing
        ? `${existing}\n[${timestamp}] ${note.trim()}`
        : `[${timestamp}] ${note.trim()}`;
      await supabase.from(tableName).update({ notes: newNotes }).eq("id", row.id);
      // Update local row data
      row.notes = newNotes;
      setNote("");
    } catch (e) {
      console.error("Save note error:", e);
    } finally {
      setSavingNote(false);
    }
  }

  // Find a display label for the record
  const isUUID = (s: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-/.test(s);
  const displayLabel = Object.entries(row).find(
    ([k, v]) => !["id", "created_at", "stage", "embedding", "notes"].includes(k) && typeof v === "string" && v.length > 2 && v.length < 80 && !isUUID(v)
  )?.[1] as string | undefined || "Record Details";

  const detailFields = Object.entries(row).filter(
    ([k]) => !["id", "created_at", "embedding"].includes(k) && !columns.includes(k)
  );

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-border/30 shrink-0 bg-gradient-to-r from-primary/5 to-transparent">
        <div className="flex items-center gap-3 min-w-0">
          <div className="h-9 w-9 rounded-xl bg-primary/10 flex items-center justify-center shrink-0">
            <span className="text-primary text-xs font-bold">
              {displayLabel.split(" ").map(w => w[0]).join("").slice(0, 2).toUpperCase()}
            </span>
          </div>
          <div className="min-w-0">
            <h3 className="text-sm font-bold truncate">{displayLabel}</h3>
            <p className="text-[11px] text-muted-foreground/60">{formatHeader(tableName)}</p>
          </div>
        </div>
        <button
          onClick={onClose}
          className="h-7 w-7 rounded-lg flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors shrink-0"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>

      {/* Scrollable content */}
      <div className="flex-1 overflow-auto custom-scroll px-6 py-5">
        <div className="flex flex-col gap-5">
          {/* Detail fields */}
          {detailFields.length > 0 && (
            <div className="grid grid-cols-2 gap-x-6 gap-y-3">
              {detailFields.map(([key, value]) => (
                <div key={key}>
                  <p className="text-[11px] font-semibold text-muted-foreground/60 uppercase tracking-wider mb-0.5">
                    {formatHeader(key)}
                  </p>
                  <p className="text-sm">{formatCell(value)}</p>
                </div>
              ))}
            </div>
          )}

          {/* Related data */}
          {loadingRelated && (
            <p className="text-xs text-muted-foreground/60">Loading related data...</p>
          )}
          {Object.keys(cache.relatedData).length > 0 && (
            <div className="flex flex-col gap-4">
              {Object.entries(cache.relatedData).map(([table, rows]) => (
                <div key={table}>
                  <p className="text-xs font-semibold text-muted-foreground/70 uppercase tracking-wider mb-2">
                    {formatHeader(table)} ({rows.length})
                  </p>
                  <div className="rounded-xl border border-border/30 overflow-hidden">
                    <div className="overflow-x-auto">
                      <table className="w-full text-xs">
                        <thead>
                          <tr className="border-b border-border/30 bg-muted/30">
                            {Object.keys(rows[0])
                              .filter((k) => !["id", "created_at", "embedding", `${tableName.replace(/s$/, "")}_id`].includes(k))
                              .slice(0, 5)
                              .map((col) => (
                                <th key={col} className="px-3 py-2 text-left font-semibold text-muted-foreground/70">
                                  {formatHeader(col)}
                                </th>
                              ))}
                          </tr>
                        </thead>
                        <tbody>
                          {rows.slice(0, 6).map((r, i) => (
                            <tr key={i} className="border-b border-border/20 last:border-0">
                              {Object.entries(r)
                                .filter(([k]) => !["id", "created_at", "embedding", `${tableName.replace(/s$/, "")}_id`].includes(k))
                                .slice(0, 5)
                                .map(([k, v]) => (
                                  <td key={k} className="px-3 py-2 text-foreground/80">
                                    {formatCell(v)}
                                  </td>
                                ))}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Notes — add context for future analyses */}
          <div className="flex flex-col gap-2">
            {(() => {
              const existingNotes = row.notes ? String(row.notes) : "";
              return existingNotes.trim() ? (
                <div className="rounded-xl bg-amber-50/50 dark:bg-amber-950/20 border border-amber-100/50 dark:border-amber-900/30 px-4 py-3">
                  <p className="text-[11px] font-semibold text-amber-700/70 dark:text-amber-400/70 uppercase tracking-wider mb-1">Notes</p>
                  <p className="text-xs text-amber-900/70 dark:text-amber-300/70 whitespace-pre-wrap leading-relaxed">{existingNotes}</p>
                </div>
              ) : null;
            })()}
            <div className="flex gap-2">
              <Input
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="Add a note for future reference..."
                className="h-8 text-xs rounded-lg flex-1"
                onKeyDown={(e) => e.key === "Enter" && saveNote()}
              />
              <Button variant="outline" size="sm" disabled={savingNote || !note.trim()} onClick={saveNote} className="h-8 text-xs shrink-0">
                {savingNote ? "Saving..." : "Save"}
              </Button>
            </div>
          </div>

          {/* Action button + duration */}
          <div className="flex items-center gap-3">
            {!cache.sections && (
              <Button size="sm" disabled={analyzing} onClick={runAnalysis}>
                {analyzing ? "Working on it..." : actionLabel}
              </Button>
            )}
            {cache.sections && (
              <Button variant="outline" size="sm" disabled={analyzing} onClick={runAnalysis}>
                {analyzing ? "Working on it..." : `Redo ${actionLabel}`}
              </Button>
            )}
            {analyzing && <ProcessingIndicator variant="analyze" />}
            {cache.error && (
              <span className="text-xs text-red-500">{cache.error}</span>
            )}
            {durationMs && !analyzing && (
              <span className="text-[11px] text-muted-foreground/50">
                Generated in {durationMs < 1000 ? `${durationMs}ms` : `${(durationMs / 1000).toFixed(1)}s`}
              </span>
            )}
          </div>

          {/* Analysis results */}
          {cache.sections && (
            <SectionRenderer sections={cache.sections} />
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Main Component ──────────────────────────────────────────────────────────

interface RowRisk {
  score: number;
  label: string;
  criticalCount: number;
}

export function DynamicTable({ config, refreshKey = 0 }: { config: TableConfig; refreshKey?: number }) {
  const [rows, setRows] = useState<Record<string, unknown>[]>([]);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [rowCaches, setRowCaches] = useState<Record<string, RowCache>>({});
  const [actionLabel, setActionLabel] = useState("Generate Analysis");
  const [search, setSearch] = useState("");
  const [riskMap, setRiskMap] = useState<Record<string, RowRisk>>({});
  const [columnFilters, setColumnFilters] = useState<Record<string, string>>({});
  const [filterOptions, setFilterOptions] = useState<Record<string, string[]>>({});
  const supabase = createClient();

  useEffect(() => {
    async function fetchData() {
      const [{ data: tableData }, { data: ac }, { data: pipelineResults }] = await Promise.all([
        supabase.from(config.source_table).select("*").limit(50),
        supabase.from("agent_config").select("action_label, persona").order("created_at", { ascending: false }).limit(1).single(),
        supabase.from("pipeline_results").select("item_id, score, sections").eq("item_table", config.source_table).order("created_at", { ascending: false }),
      ]);
      if (tableData) {
        const typedRows = tableData as unknown as Record<string, unknown>[];
        setRows(typedRows);

        // Auto-detect filterable columns: text columns with 2-15 unique values
        const opts: Record<string, string[]> = {};
        for (const col of config.columns) {
          const values = typedRows.map((r) => r[col]).filter((v) => typeof v === "string" && v.length > 0 && v.length < 60 && !/^[0-9a-f]{8}-/.test(v));
          const unique = [...new Set(values as string[])].sort();
          if (unique.length >= 2 && unique.length <= 15) {
            opts[col] = unique;
          }
        }
        setFilterOptions(opts);
      }
      if (ac?.action_label) setActionLabel(ac.action_label);

      // Build risk map from pipeline results
      if (pipelineResults && pipelineResults.length > 0) {
        const rm: Record<string, RowRisk> = {};
        for (const pr of pipelineResults) {
          if (pr.item_id && !rm[pr.item_id]) {
            const checklist = (pr.sections as OutputSection[])?.find((s) => s.type === "checklist");
            const items = checklist ? (checklist.data as { items?: Array<{ passed: boolean; severity: string; label: string }> })?.items || [] : [];
            const criticals = items.filter((i) => !i.passed && i.severity === "critical");
            const warnings = items.filter((i) => !i.passed && i.severity === "warning");
            const topIssue = criticals[0]?.label || warnings[0]?.label || "";
            rm[pr.item_id] = {
              score: pr.score ?? 100,
              label: topIssue,
              criticalCount: criticals.length,
            };
          }
        }
        setRiskMap(rm);
      }
    }
    fetchData();
  }, [config, refreshKey]);

  const getCache = useCallback((rowId: string): RowCache => {
    return rowCaches[rowId] || { relatedData: {}, sections: null, relatedLoaded: false, error: null };
  }, [rowCaches]);

  const updateCache = useCallback((rowId: string, update: Partial<RowCache>) => {
    setRowCaches((prev) => ({
      ...prev,
      [rowId]: { ...prev[rowId] || { relatedData: {}, sections: null, relatedLoaded: false, error: null }, ...update },
    }));
  }, []);

  // Filter rows by search + column filters, then sort by urgency
  const hasRiskData = Object.keys(riskMap).length > 0;
  const activeFilters = Object.entries(columnFilters).filter(([, v]) => v !== "");
  const filteredRows = rows.filter((row) => {
    // Column filters
    for (const [col, val] of activeFilters) {
      if (String(row[col] ?? "") !== val) return false;
    }
    // Text search
    if (search.trim()) {
      return config.columns.some((col) =>
        String(row[col] ?? "").toLowerCase().includes(search.toLowerCase())
      );
    }
    return true;
  }).sort((a, b) => {
    if (!hasRiskData) return 0;
    const sa = riskMap[String(a.id)]?.score ?? 100;
    const sb = riskMap[String(b.id)]?.score ?? 100;
    return sa - sb; // lowest score (most urgent) first
  });

  const selectedRow = expandedId ? rows.find((r) => String(r.id) === expandedId) : null;

  if (!config.columns.length) return null;

  return (
    <Card className="overflow-hidden">
      <div className="flex h-[600px]">
        {/* Left: Table list */}
        <div className={`flex flex-col min-w-0 ${selectedRow ? "w-[45%] shrink-0 border-r border-border/30" : "flex-1"} transition-all duration-300`}>
          <CardHeader className="shrink-0">
            <div className="flex items-center justify-between mb-2">
              <div>
                <CardTitle className="text-sm font-semibold">
                  {formatHeader(config.source_table)}
                </CardTitle>
                {!selectedRow && rows.length > 0 && (
                  <p className="text-[11px] text-muted-foreground/50 mt-0.5">
                    Select a record to view details and {actionLabel.toLowerCase()}
                  </p>
                )}
              </div>
              <Badge variant="secondary" className="text-xs shrink-0">
                {filteredRows.length}{(search || activeFilters.length > 0) ? `/${rows.length}` : ""} records
              </Badge>
            </div>
            <div className="flex gap-2">
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search..."
                className="h-8 text-xs rounded-lg bg-muted/30 border-border/40 flex-1"
              />
              {activeFilters.length > 0 && (
                <button
                  onClick={() => setColumnFilters({})}
                  className="h-8 px-2 text-[10px] text-muted-foreground hover:text-foreground transition-colors shrink-0"
                >
                  Clear filters
                </button>
              )}
            </div>
            {Object.keys(filterOptions).length > 0 && (
              <div className="flex flex-wrap gap-1.5 mt-2">
                {Object.entries(filterOptions).map(([col, options]) => (
                  <select
                    key={col}
                    value={columnFilters[col] || ""}
                    onChange={(e) => setColumnFilters((prev) => ({ ...prev, [col]: e.target.value }))}
                    className={`h-7 rounded-lg border text-[11px] px-2 pr-6 appearance-none bg-no-repeat bg-[right_4px_center] bg-[length:12px] transition-colors ${
                      columnFilters[col]
                        ? "border-primary/40 bg-primary/5 text-primary font-semibold"
                        : "border-border/40 bg-card text-muted-foreground"
                    }`}
                    style={{ backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%23999' stroke-width='2'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E")` }}
                  >
                    <option value="">{formatHeader(col)}</option>
                    {options.map((opt) => (
                      <option key={opt} value={opt}>{opt}</option>
                    ))}
                  </select>
                ))}
              </div>
            )}
          </CardHeader>
          <CardContent className="flex-1 overflow-auto custom-scroll p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  {config.columns.map((col) => (
                    <TableHead key={col} className="text-[11px] font-semibold px-4">
                      {formatHeader(col)}
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredRows.map((row) => {
                  const rowId = String(row.id || "");
                  const isSelected = expandedId === rowId;
                  const risk = riskMap[rowId];
                  return (
                    <TableRow
                      key={rowId}
                      className={`cursor-pointer transition-colors ${
                        isSelected
                          ? "bg-primary/[0.06] border-l-2 border-l-primary"
                          : "hover:bg-primary/[0.03]"
                      }`}
                      onClick={() => setExpandedId(isSelected ? null : rowId)}
                    >
                      {config.columns.map((col, ci) => (
                        <TableCell key={col} className="px-4 py-2.5 text-xs">
                          <div className="flex items-center gap-2">
                            {/* Risk indicator on first column */}
                            {ci === 0 && risk && (
                              <span
                                className={`h-2 w-2 rounded-full shrink-0 ${
                                  risk.score >= 80 ? "bg-emerald-500" :
                                  risk.score >= 50 ? "bg-amber-500" :
                                  "bg-red-500"
                                }`}
                                title={`Score: ${risk.score}/100${risk.label ? ` — ${risk.label}` : ""}`}
                              />
                            )}
                            <span className={isSelected ? "font-semibold text-primary" : ""}>
                              {formatCell(row[col])}
                            </span>
                          </div>
                        </TableCell>
                      ))}
                    </TableRow>
                  );
                })}
                {filteredRows.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={config.columns.length} className="text-center text-muted-foreground py-8 text-xs">
                      {search ? "No matching records" : "No data"}
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </CardContent>
        </div>

        {/* Right: Detail panel */}
        {selectedRow && (
          <div className="flex-1 min-w-0 bg-muted/10">
            <DetailPanel
              row={selectedRow}
              tableName={config.source_table}
              columns={config.columns}
              cache={getCache(expandedId!)}
              onCacheUpdate={(update) => updateCache(expandedId!, update)}
              actionLabel={actionLabel}
              onClose={() => setExpandedId(null)}
            />
          </div>
        )}

        {/* Empty state when no record selected (wide screens) */}
        {!selectedRow && rows.length > 0 && (
          <div className="hidden xl:flex flex-1 items-center justify-center bg-muted/5">
            <div className="text-center">
              <div className="h-12 w-12 rounded-2xl bg-primary/5 flex items-center justify-center mx-auto mb-3">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-primary/40">
                  <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" />
                  <polyline points="14,2 14,8 20,8" />
                </svg>
              </div>
              <p className="text-sm text-muted-foreground/40">Select a record to get started</p>
            </div>
          </div>
        )}
      </div>
    </Card>
  );
}
