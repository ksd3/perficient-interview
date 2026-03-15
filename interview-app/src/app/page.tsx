"use client";

import { useEffect, useState, useCallback } from "react";
import { createClient } from "@/lib/supabase";
import type { AppConfig, PanelType, OutputSection } from "@/lib/types";
import { DashboardPanel } from "@/components/panels/DashboardPanel";
import { DocumentUploadPanel } from "@/components/panels/DocumentUploadPanel";
import { WorkflowPanel } from "@/components/panels/WorkflowPanel";
import { FormPanel } from "@/components/panels/FormPanel";
import { ResearchPanel } from "@/components/panels/ResearchPanel";
import { ChatPanel } from "@/components/ChatPanel";
import { ThemeToggle } from "@/components/ThemeToggle";
import { CustomizeInput } from "@/components/CustomizeInput";

// Nav items for each panel type
const NAV_META: Record<string, { label: string; icon: React.ReactNode }> = {
  document_upload: {
    label: "Documents",
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" />
        <polyline points="14,2 14,8 20,8" />
        <line x1="12" y1="18" x2="12" y2="12" />
        <line x1="9" y1="15" x2="15" y2="15" />
      </svg>
    ),
  },
  form: {
    label: "Intake",
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="3" width="18" height="18" rx="2" />
        <path d="M9 12h6" />
        <path d="M9 16h6" />
        <path d="M9 8h6" />
      </svg>
    ),
  },
  workflow: {
    label: "Workflow",
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="3" width="6" height="6" rx="1" />
        <rect x="15" y="3" width="6" height="6" rx="1" />
        <rect x="9" y="15" width="6" height="6" rx="1" />
        <path d="M6 9v3a1 1 0 0 0 1 1h4" />
        <path d="M18 9v3a1 1 0 0 1-1 1h-4" />
        <line x1="12" y1="13" x2="12" y2="15" />
      </svg>
    ),
  },
  dashboard: {
    label: "Dashboard",
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="13" width="4" height="8" rx="1" />
        <rect x="10" y="8" width="4" height="13" rx="1" />
        <rect x="17" y="3" width="4" height="18" rx="1" />
      </svg>
    ),
  },
  research: {
    label: "Research",
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="11" cy="11" r="8" />
        <line x1="21" y1="21" x2="16.65" y2="16.65" />
      </svg>
    ),
  },
};

export default function Home() {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pipelineSections, setPipelineSections] = useState<OutputSection[]>([]);
  const [activeTab, setActiveTab] = useState<string | null>(null);
  const supabase = createClient();

  useEffect(() => {
    if (config?.title) document.title = config.title;
  }, [config?.title]);

  const fetchConfig = useCallback(async () => {
    const { data, error: err } = await supabase
      .from("app_config")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(1)
      .single();

    if (err) {
      setError(err.code === "PGRST116" ? "no_config" : err.message);
    } else {
      setError(null);
      const cfg = data as AppConfig;
      setConfig(cfg);

      // Apply theme overrides from config
      const theme = cfg.theme as Record<string, string> | undefined;
      if (theme && typeof theme === "object") {
        const root = document.documentElement;
        if (theme.primary) root.style.setProperty("--primary", theme.primary);
        if (theme.background) root.style.setProperty("--background", theme.background);
        if (theme.card) root.style.setProperty("--card", theme.card);
        if (theme.foreground) root.style.setProperty("--foreground", theme.foreground);
        if (theme.accent) root.style.setProperty("--accent", theme.accent);
      }
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchConfig();
    const channel = supabase
      .channel("app-reconfigure")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "dashboard_updates" },
        (payload) => {
          const data = payload.new as { component_id?: string };
          if (data.component_id === "full_reconfigure") fetchConfig();
        }
      )
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [fetchConfig]);

  const handlePipelineResults = useCallback((sections: OutputSection[]) => {
    setPipelineSections(sections);
    if (config) {
      const layout = resolveLayout(config);
      if (layout.includes("workflow")) setActiveTab("workflow");
    }
  }, [config]);

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-4">
          <div className="h-10 w-10 rounded-2xl bg-gradient-to-br from-primary to-primary/70 flex items-center justify-center shadow-lg shadow-primary/20">
            <span className="text-primary-foreground text-sm font-bold">AI</span>
          </div>
          <div className="h-1 w-16 rounded-full bg-muted overflow-hidden">
            <div className="h-full w-1/2 rounded-full bg-primary animate-[shimmer_1.5s_ease-in-out_infinite]" />
          </div>
        </div>
      </div>
    );
  }

  if (error === "no_config" || !config) {
    return <GenerationScreen supabase={supabase} onReady={fetchConfig} />;
  }

  const layout = resolveLayout(config);
  const hasSidebar = layout.includes("chat_sidebar");
  const mainPanels = layout.filter((p) => p !== "chat_sidebar");

  // Chat-only mode
  if (mainPanels.length === 0 && hasSidebar) {
    return (
      <div className="h-screen flex flex-col bg-background">
        <ChatPanel persona={config.persona} quickActions={config.quick_actions} />
      </div>
    );
  }

  const currentTab = activeTab || mainPanels[0];
  const showNav = mainPanels.length > 1;

  return (
    <div className="h-screen flex bg-background">
      {/* Left sidebar nav — frosted glass */}
      {showNav && (
        <nav className="flex w-[260px] shrink-0 flex-col border-r border-border/50 bg-card/80 glass">
          {/* User identity or app identity */}
          {(() => {
            const userCtx = (config.layout_overrides as Record<string, unknown>)?.user_context as { name?: string; role?: string; details?: string } | undefined;
            if (userCtx?.name) {
              const initials = userCtx.name.split(" ").map(w => w[0]).join("").slice(0, 2).toUpperCase();
              return (
                <div className="px-5 py-5 border-b border-border/30">
                  <div className="flex items-center gap-3">
                    <div className="h-10 w-10 rounded-full bg-gradient-to-br from-primary to-primary/60 flex items-center justify-center shadow-md shadow-primary/20 shrink-0">
                      <span className="text-primary-foreground text-xs font-bold">{initials}</span>
                    </div>
                    <div className="min-w-0">
                      <p className="text-[13px] font-semibold truncate">{userCtx.name}</p>
                      {userCtx.role && <p className="text-[11px] text-muted-foreground truncate">{userCtx.role}</p>}
                    </div>
                  </div>
                  {userCtx.details && (
                    <p className="text-[10px] text-muted-foreground/60 mt-2 leading-relaxed">{userCtx.details}</p>
                  )}
                  <p className="text-[10px] text-primary/50 font-medium mt-1.5">{config.title}</p>
                </div>
              );
            }
            return (
              <div className="flex items-center gap-3 px-5 py-5 border-b border-border/30">
                <div className="h-9 w-9 rounded-xl bg-gradient-to-br from-primary to-primary/70 flex items-center justify-center shadow-md shadow-primary/20">
                  <span className="text-primary-foreground text-xs font-bold tracking-tight">
                    {config.title.split(" ").map(w => w[0]).join("").slice(0, 2)}
                  </span>
                </div>
                <div className="min-w-0">
                  <h1 className="text-[13px] font-semibold tracking-tight truncate">{config.title}</h1>
                  {config.description && (
                    <p className="text-[11px] text-muted-foreground truncate leading-tight mt-0.5">{config.description}</p>
                  )}
                </div>
              </div>
            );
          })()}

          {/* Nav items */}
          <div className="flex flex-col gap-1 p-3 flex-1">
            {mainPanels.map((panel) => {
              const meta = NAV_META[panel] || { label: panel, icon: null };
              const isActive = currentTab === panel;
              return (
                <button
                  key={panel}
                  onClick={() => setActiveTab(panel)}
                  className={`flex items-center gap-3 rounded-xl px-3.5 py-2.5 text-[13px] transition-all duration-200 text-left ${
                    isActive
                      ? "bg-primary/10 text-primary font-semibold shadow-sm nav-active"
                      : "text-muted-foreground hover:text-foreground hover:bg-accent/60"
                  }`}
                >
                  <span className={`flex h-8 w-8 items-center justify-center rounded-lg transition-colors duration-200 ${isActive ? "bg-primary/15 text-primary" : "bg-muted/50 text-muted-foreground"}`}>
                    {meta.icon}
                  </span>
                  {meta.label}
                </button>
              );
            })}
          </div>

          {/* Footer: customize + persona + theme */}
          <div className="border-t border-border/30">
            <div className="px-4 pt-3 pb-2">
              <CustomizeInput />
            </div>
            {config.persona && (
              <div className="px-5 pb-2">
                <p className="text-[10px] uppercase tracking-widest text-muted-foreground/70 mb-0.5 font-medium">AI Persona</p>
                <p className="text-[11px] text-foreground/60 leading-snug">{config.persona}</p>
              </div>
            )}
            <div className="px-5 pb-3 flex justify-end">
              <ThemeToggle />
            </div>
          </div>
        </nav>
      )}

      {/* Main content */}
      <div className="flex flex-1 min-w-0 overflow-hidden">
        <main className="flex-1 overflow-auto p-8 custom-scroll mx-auto w-full max-w-[1400px]">
          {/* Inline title for single-panel layouts */}
          {!showNav && (
            <div className="flex items-center justify-between mb-8">
              <div className="flex items-center gap-3.5">
                <div className="h-10 w-10 rounded-xl bg-gradient-to-br from-primary to-primary/70 flex items-center justify-center shadow-md shadow-primary/20">
                  <span className="text-primary-foreground text-xs font-bold">
                    {config.title.split(" ").map(w => w[0]).join("").slice(0, 2)}
                  </span>
                </div>
                <div>
                  <h1 className="text-lg font-bold tracking-tight">{config.title}</h1>
                  {config.description && (
                    <p className="text-[12px] text-muted-foreground leading-tight mt-0.5">{config.description}</p>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-3">
                <div className="w-56">
                  <CustomizeInput />
                </div>
                <ThemeToggle />
              </div>
            </div>
          )}

          {mainPanels.map((panel) => (
            <div key={panel} className={`transition-opacity duration-200 ${currentTab === panel ? "opacity-100" : "hidden opacity-0"}`}>
              <PanelContent
                panel={panel}
                config={config}
                pipelineSections={pipelineSections}
                onPipelineResults={handlePipelineResults}
                hasWorkflow={layout.includes("workflow")}
              />
            </div>
          ))}
        </main>

        {/* Chat sidebar — frosted glass */}
        {hasSidebar && (
          <div className="w-[400px] shrink-0 border-l border-border/30 bg-card/60 glass">
            <ChatPanel persona={config.persona} quickActions={config.quick_actions} />
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveLayout(config: AppConfig): PanelType[] {
  if (config.layout && config.layout.length > 0) return config.layout;
  if (config.template_id) {
    const legacyMap: Record<string, PanelType[]> = {
      dashboard: ["dashboard", "chat_sidebar"],
      document_analyzer: ["document_upload", "chat_sidebar"],
      workflow: ["workflow", "chat_sidebar"],
      chat: ["chat_sidebar"],
      research: ["research", "chat_sidebar"],
    };
    return legacyMap[config.template_id] || ["dashboard", "chat_sidebar"];
  }
  return ["dashboard", "chat_sidebar"];
}

function GenerationScreen({
  supabase,
  onReady,
}: {
  supabase: ReturnType<typeof createClient>;
  onReady: () => void;
}) {
  const [progress, setProgress] = useState<{ message: string; step: number; total: number } | null>(null);

  useEffect(() => {
    const channel = supabase
      .channel("generation-progress")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "dashboard_updates" },
        (payload) => {
          const data = payload.new as { component_id?: string; data?: Record<string, unknown> };
          if (data.component_id === "generation_progress" && data.data) {
            setProgress(data.data as { message: string; step: number; total: number });
          }
          if (data.component_id === "full_reconfigure") {
            onReady();
          }
        }
      )
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [supabase, onReady]);

  const pct = progress ? (progress.step / progress.total) * 100 : 0;

  return (
    <div className="flex h-screen flex-col items-center justify-center gap-8 bg-background">
      <div className="h-16 w-16 rounded-3xl bg-gradient-to-br from-primary to-primary/60 flex items-center justify-center shadow-xl shadow-primary/20">
        <span className="text-primary-foreground text-xl font-bold">AI</span>
      </div>
      <div className="text-center">
        <h1 className="text-2xl font-bold tracking-tight">
          {progress ? "Building your app..." : "Ready to configure"}
        </h1>
        <p className="mt-3 max-w-sm text-base text-muted-foreground leading-relaxed">
          {progress
            ? progress.message
            : "Run the meta-agent with a scenario to get started."}
        </p>
      </div>
      {progress ? (
        <div className="w-64 flex flex-col items-center gap-3">
          <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
            <div
              className="h-full rounded-full bg-primary transition-all duration-700 ease-out"
              style={{ width: `${pct}%` }}
            />
          </div>
          <span className="text-xs text-muted-foreground/60">Step {progress.step} of {progress.total}</span>
        </div>
      ) : (
        <code className="rounded-2xl bg-card border border-border/40 px-6 py-3.5 text-sm font-mono shadow-sm">
          python meta_agent.py &quot;Your scenario here&quot;
        </code>
      )}
    </div>
  );
}

function PanelContent({
  panel,
  config,
  pipelineSections,
  onPipelineResults,
  hasWorkflow,
}: {
  panel: PanelType;
  config: AppConfig;
  pipelineSections: OutputSection[];
  onPipelineResults: (sections: OutputSection[]) => void;
  hasWorkflow: boolean;
}) {
  switch (panel) {
    case "dashboard":
      return <DashboardPanel config={config} />;
    case "document_upload":
      return <DocumentUploadPanel config={config} onResults={onPipelineResults} hasWorkflow={hasWorkflow} />;
    case "workflow":
      return <WorkflowPanel config={config} />;
    case "pipeline_results":
      return pipelineSections.length > 0 ? (
        <p>Pipeline results</p>
      ) : (
        <p className="text-center text-sm text-muted-foreground py-8">
          No analysis results yet.
        </p>
      );
    case "form":
      return <FormPanel config={config} onResults={onPipelineResults} />;
    case "research":
      return <ResearchPanel config={config} />;
    default:
      return null;
  }
}
