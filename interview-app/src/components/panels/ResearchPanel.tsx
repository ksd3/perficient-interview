"use client";

import { useState, useEffect, useSyncExternalStore } from "react";
import ReactMarkdown from "react-markdown";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { ProcessingIndicator } from "@/components/ui/processing-indicator";
import { createClient } from "@/lib/supabase";
import { getFocusContext, subscribeFocusContext } from "@/lib/focus-context";
import type { AppConfig } from "@/lib/types";

interface Source {
  title: string;
  url?: string;
  snippet: string;
}

interface DataStat {
  table: string;
  count: number;
}

export function ResearchPanel({ config }: { config?: AppConfig }) {
  const [query, setQuery] = useState("");
  const [isResearching, setIsResearching] = useState(false);
  const [sources, setSources] = useState<Source[]>([]);
  const [report, setReport] = useState("");
  const [activeTab, setActiveTab] = useState<"report" | "sources">("report");
  const [suggestedQueries, setSuggestedQueries] = useState<string[]>([]);
  const [dataStats, setDataStats] = useState<DataStat[]>([]);
  const focus = useSyncExternalStore(subscribeFocusContext, getFocusContext, () => null);
  const supabase = createClient();

  // Fetch data context on mount
  useEffect(() => {
    async function fetchContext() {
      // Get quick_actions as suggested queries
      if (config?.quick_actions?.length) {
        setSuggestedQueries(config.quick_actions.map((a) => a.prompt));
      }

      // Get data stats
      const { data: ac } = await supabase
        .from("agent_config")
        .select("source_tables")
        .order("created_at", { ascending: false })
        .limit(1)
        .single();

      if (ac?.source_tables) {
        const stats: DataStat[] = [];
        for (const table of (ac.source_tables as string[]).slice(0, 6)) {
          const { count } = await supabase
            .from(table)
            .select("*", { count: "exact", head: true });
          if (count !== null && count > 0) {
            stats.push({ table, count });
          }
        }
        setDataStats(stats);
      }
    }
    fetchContext();
  }, [config]);

  async function startResearch(q?: string) {
    const searchQuery = q || query;
    if (!searchQuery.trim()) return;
    setQuery(searchQuery);
    setIsResearching(true);
    setSources([]);
    setReport("");
    setActiveTab("report");

    try {
      const res = await fetch("/api/research", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: searchQuery }),
      });

      const data = await res.json();
      setSources(data.sources || []);
      setReport(data.report || (res.ok ? "" : "Research failed. Please try again."));
    } catch {
      setReport("Research failed. Please try again.");
    } finally {
      setIsResearching(false);
    }
  }

  const hasResults = sources.length > 0 || report;
  const persona = config?.persona || "AI Research Assistant";

  return (
    <div className="flex flex-col gap-5">
      {/* Contextual header */}
      <div>
        <h2 className="text-base font-bold tracking-tight">{config?.title || "Research"}</h2>
        {config?.description && (
          <p className="text-sm text-muted-foreground/70 mt-1 leading-relaxed">{config.description}</p>
        )}
      </div>

      {/* Search Bar */}
      <Card>
        <CardContent className="flex flex-col gap-4 pt-5">
          <div className="flex gap-3">
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={`Ask ${persona.toLowerCase()} to research anything...`}
              onKeyDown={(e) => e.key === "Enter" && startResearch()}
              className="h-10 rounded-xl bg-muted/30 border-border/40"
            />
            <Button onClick={() => startResearch()} disabled={isResearching || !query.trim()}>
              {isResearching ? "Researching..." : "Research"}
            </Button>
          </div>

          {/* Context-aware suggestions when a record is focused */}
          {!hasResults && focus && (
            <div className="rounded-xl bg-primary/[0.03] border border-primary/10 px-4 py-3">
              <p className="text-[11px] font-semibold text-primary/70 uppercase tracking-wider mb-2">
                Research for {Object.entries(focus.record).find(([k, v]) => !["id", "created_at", "stage", "embedding", "notes"].includes(k) && typeof v === "string" && v.length > 2 && v.length < 60 && !/^[0-9a-f]{8}-[0-9a-f]{4}-/.test(v))?.[1] as string || "selected record"}
              </p>
              <div className="flex flex-wrap gap-2">
                {Object.entries(focus.record)
                  .filter(([k, v]) => !["id", "created_at", "embedding", "stage"].includes(k) && typeof v === "string" && v.length > 3 && v.length < 50)
                  .slice(0, 3)
                  .map(([k, v]) => (
                    <button
                      key={k}
                      onClick={() => startResearch(`Research ${String(v)} — ${k.replace(/_/g, " ")} context and latest developments`)}
                      className="text-xs text-primary/70 bg-primary/5 hover:bg-primary/10 rounded-lg px-3 py-1.5 transition-colors text-left"
                    >
                      Research {String(v)}
                    </button>
                  ))}
              </div>
            </div>
          )}

          {/* General suggested queries */}
          {!hasResults && !focus && suggestedQueries.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {suggestedQueries.map((sq, i) => (
                <button
                  key={i}
                  onClick={() => startResearch(sq)}
                  className="text-xs text-muted-foreground/70 bg-muted/40 hover:bg-muted/70 hover:text-foreground rounded-lg px-3 py-1.5 transition-colors text-left"
                >
                  {sq.length > 60 ? sq.slice(0, 57) + "..." : sq}
                </button>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {isResearching && (
        <div className="px-1">
          <ProcessingIndicator variant="analyze" />
        </div>
      )}

      {/* Data context — shown when no results yet */}
      {!hasResults && !isResearching && dataStats.length > 0 && (
        <div>
          <p className="text-[11px] font-semibold text-muted-foreground/60 uppercase tracking-wider mb-3 px-1">
            Available Data
          </p>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            {dataStats.map((stat, i) => {
              const colors = [
                "from-blue-500/10 to-blue-600/5 text-blue-700 dark:text-blue-400",
                "from-purple-500/10 to-purple-600/5 text-purple-700 dark:text-purple-400",
                "from-emerald-500/10 to-emerald-600/5 text-emerald-700 dark:text-emerald-400",
                "from-amber-500/10 to-amber-600/5 text-amber-700 dark:text-amber-400",
                "from-rose-500/10 to-rose-600/5 text-rose-700 dark:text-rose-400",
                "from-cyan-500/10 to-cyan-600/5 text-cyan-700 dark:text-cyan-400",
              ];
              return (
                <div key={stat.table} className={`rounded-2xl bg-gradient-to-br ${colors[i % colors.length]} border border-border/30 p-4`}>
                  <p className="text-2xl font-bold tracking-tight">{stat.count}</p>
                  <p className="text-[11px] text-muted-foreground/70 uppercase tracking-wider mt-0.5">
                    {stat.table.replace(/_/g, " ")}
                  </p>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Results */}
      {hasResults && (
        <div>
          <div className="flex gap-1 mb-4">
            <button
              onClick={() => setActiveTab("report")}
              className={`flex items-center gap-1.5 rounded-full px-4 py-1.5 text-xs font-semibold transition-all duration-200 ${
                activeTab === "report"
                  ? "bg-primary text-primary-foreground shadow-sm shadow-primary/20"
                  : "bg-card border border-border/40 text-muted-foreground hover:text-foreground"
              }`}
            >
              Report
            </button>
            <button
              onClick={() => setActiveTab("sources")}
              className={`flex items-center gap-1.5 rounded-full px-4 py-1.5 text-xs font-semibold transition-all duration-200 ${
                activeTab === "sources"
                  ? "bg-primary text-primary-foreground shadow-sm shadow-primary/20"
                  : "bg-card border border-border/40 text-muted-foreground hover:text-foreground"
              }`}
            >
              Sources
              {sources.length > 0 && (
                <span className={`flex h-4 min-w-4 items-center justify-center rounded-full px-1.5 text-[10px] font-bold ${
                  activeTab === "sources" ? "bg-primary-foreground/20 text-primary-foreground" : "bg-muted text-muted-foreground"
                }`}>
                  {sources.length}
                </span>
              )}
            </button>
          </div>

          {activeTab === "report" && (
            <Card>
              <CardContent className="pt-6 pb-6">
                <div className="prose prose-sm max-w-none text-sm leading-relaxed prose-headings:font-semibold prose-headings:tracking-tight prose-h1:text-lg prose-h2:text-base prose-h3:text-sm prose-p:text-foreground/85 prose-li:text-foreground/85 prose-strong:text-foreground prose-a:text-primary prose-a:no-underline hover:prose-a:underline prose-code:rounded prose-code:bg-muted prose-code:px-1 prose-code:py-0.5 prose-code:text-xs prose-hr:border-border/40">
                  <ReactMarkdown>{report || "Report will appear here after research is complete."}</ReactMarkdown>
                </div>
              </CardContent>
            </Card>
          )}

          {activeTab === "sources" && (
            <div className="flex flex-col gap-3.5">
              {sources.length === 0 && (
                <p className="text-sm text-muted-foreground/60 text-center py-8">No sources found.</p>
              )}
              {sources.map((source, i) => (
                <Card key={i}>
                  <CardHeader>
                    <CardTitle className="text-sm font-semibold">
                      {source.url ? (
                        <a href={source.url} target="_blank" rel="noopener noreferrer" className="hover:text-primary transition-colors">
                          {source.title}
                        </a>
                      ) : (
                        source.title
                      )}
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <p className="text-sm text-muted-foreground/80 leading-relaxed">{source.snippet}</p>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
