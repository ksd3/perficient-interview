"use client";

import { useState } from "react";
import type { OutputSection, ScoreData } from "@/lib/types";
import { ChecklistSection } from "./ChecklistSection";
import { FieldTableSection } from "./FieldTableSection";
import { ScoreSection } from "./ScoreSection";
import { ListSection } from "./ListSection";
import { TextSection } from "./TextSection";
import { KVPairsSection } from "./KVPairsSection";
import { DocumentSection } from "./DocumentSection";
import { RecordMatchSection } from "./RecordMatchSection";

const RENDERERS: Record<string, React.ComponentType<{ section: OutputSection }>> = {
  checklist: ChecklistSection,
  field_table: FieldTableSection,
  score: ScoreSection,
  list: ListSection,
  text: TextSection,
  kv_pairs: KVPairsSection,
  document: DocumentSection,
  web_search_results: ListSection,
  record_match: RecordMatchSection,
};

// Narrative types = the main output the user cares about
const NARRATIVE_TYPES = new Set(["document", "text", "list"]);
// Supporting detail types = technical/reference info behind tabs
const DETAIL_TYPES = new Set(["checklist", "field_table", "kv_pairs", "web_search_results", "record_match"]);

export function SectionRenderer({ sections }: { sections: OutputSection[] }) {
  const scoreSections = sections.filter((s) => s.type === "score");
  const narrativeSections = sections.filter((s) => NARRATIVE_TYPES.has(s.type));
  const detailSections = sections.filter((s) => DETAIL_TYPES.has(s.type));

  const [activeDetail, setActiveDetail] = useState(0);

  // Simple layout for few sections
  if (sections.length <= 3) {
    return (
      <div className="flex flex-col gap-4">
        {sections.map((section) => {
          const Renderer = RENDERERS[section.type] || KVPairsSection;
          return <Renderer key={section.id} section={section} />;
        })}
      </div>
    );
  }

  // Compute overall verdict from scores
  const allScores = scoreSections.map((s) => (s.data as ScoreData).score);
  const avgScore = allScores.length > 0 ? Math.round(allScores.reduce((a, b) => a + b, 0) / allScores.length) : null;
  const summaryText = narrativeSections.find((s) => s.type === "text");
  // Extract first sentence of summary for the verdict subtitle
  const summaryFirstLine = summaryText
    ? ((summaryText.data as { content?: string }).content || "").split(/[.!?]\s/)[0] + "."
    : null;

  return (
    <div className="flex flex-col gap-5">
      {/* 0. Verdict banner — the ANSWER */}
      {avgScore !== null && (
        <div className={`rounded-2xl p-5 flex items-center gap-4 ${
          avgScore >= 80
            ? "bg-gradient-to-r from-emerald-500/15 to-emerald-500/5 border border-emerald-200/60"
            : avgScore >= 50
              ? "bg-gradient-to-r from-amber-500/15 to-amber-500/5 border border-amber-200/60"
              : "bg-gradient-to-r from-red-500/15 to-red-500/5 border border-red-200/60"
        }`}>
          <div className={`flex h-14 w-14 items-center justify-center rounded-2xl shrink-0 text-lg font-bold ${
            avgScore >= 80
              ? "bg-emerald-500/20 text-emerald-700 dark:text-emerald-400"
              : avgScore >= 50
                ? "bg-amber-500/20 text-amber-700 dark:text-amber-400"
                : "bg-red-500/20 text-red-700 dark:text-red-400"
          }`}>
            {avgScore >= 80 ? "\u2713" : avgScore >= 50 ? "!" : "\u2717"}
          </div>
          <div className="flex-1 min-w-0">
            <p className={`text-lg font-bold ${
              avgScore >= 80
                ? "text-emerald-700 dark:text-emerald-400"
                : avgScore >= 50
                  ? "text-amber-700 dark:text-amber-400"
                  : "text-red-700 dark:text-red-400"
            }`}>
              {avgScore >= 80 ? "Recommended: Approve" : avgScore >= 50 ? "Needs Review" : "Flag for Review"}
            </p>
            {summaryFirstLine && (
              <p className="text-sm text-muted-foreground mt-0.5 line-clamp-2">{summaryFirstLine}</p>
            )}
          </div>
          <div className="text-right shrink-0">
            <p className={`text-2xl font-bold ${
              avgScore >= 80 ? "text-emerald-600" : avgScore >= 50 ? "text-amber-600" : "text-red-500"
            }`}>{avgScore}</p>
            <p className="text-[10px] text-muted-foreground/60 uppercase tracking-wider">/ 100</p>
          </div>
        </div>
      )}

      {/* 1. Scores — compact hero row */}
      {scoreSections.length > 0 && (
        <div className={`grid gap-4 grid-cols-1 ${scoreSections.length === 2 ? "sm:grid-cols-2" : scoreSections.length >= 3 ? "sm:grid-cols-2 lg:grid-cols-3" : ""}`}>
          {scoreSections.map((s) => {
            const data = s.data as ScoreData;
            const pct = data.max > 0 ? (data.score / data.max) * 100 : 0;
            const color = pct >= 80 ? "text-emerald-600" : pct >= 50 ? "text-amber-600" : "text-red-500";
            const bgColor = pct >= 80 ? "bg-emerald-500" : pct >= 50 ? "bg-amber-500" : "bg-red-500";
            const statusText = pct >= 80 ? "Good" : pct >= 50 ? "Needs Review" : "High Risk";

            const gradBg = pct >= 80 ? "from-emerald-500/10 to-emerald-600/5" : pct >= 50 ? "from-amber-500/10 to-amber-600/5" : "from-red-500/10 to-red-600/5";

            return (
              <div key={s.id} className={`rounded-2xl bg-gradient-to-br ${gradBg} border border-border/30 p-5 flex items-center gap-5`}>
                <div className={`flex h-16 w-16 items-center justify-center rounded-2xl shrink-0 ${
                  pct >= 80 ? "bg-emerald-500/15" : pct >= 50 ? "bg-amber-500/15" : "bg-red-500/15"
                }`}>
                  <div className="text-center">
                    <div className={`text-2xl font-bold ${color}`}>{data.score}</div>
                  </div>
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-semibold truncate">{s.title}</div>
                  <div className={`text-xs font-medium ${color}`}>{statusText}</div>
                  <div className="mt-2 h-2 w-full rounded-full bg-background/60">
                    <div className={`h-2 rounded-full transition-all duration-700 ease-out ${bgColor}`} style={{ width: `${pct}%` }} />
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* 2. Narrative — the main output (summary, recommendations, generated document) */}
      {narrativeSections.map((section) => {
        const Renderer = RENDERERS[section.type] || KVPairsSection;
        return <Renderer key={section.id} section={section} />;
      })}

      {/* 3. Supporting details — tabbed (checklist, extracted fields, web results, matches) */}
      {detailSections.length > 0 && (
        <div className="rounded-2xl border border-border/40 bg-card shadow-sm">
          <div className="flex border-b border-border/40 overflow-x-auto px-1">
            {detailSections.map((section, i) => (
              <button
                key={section.id}
                onClick={() => setActiveDetail(i)}
                className={`px-4 py-3 text-[13px] font-medium whitespace-nowrap border-b-2 transition-all duration-200 ${
                  activeDetail === i
                    ? "border-primary text-primary"
                    : "border-transparent text-muted-foreground/70 hover:text-foreground"
                }`}
              >
                {section.title}
              </button>
            ))}
          </div>
          <div className="p-5">
            {(() => {
              const section = detailSections[activeDetail];
              if (!section) return null;
              const Renderer = RENDERERS[section.type] || KVPairsSection;
              return <Renderer section={section} />;
            })()}
          </div>
        </div>
      )}
    </div>
  );
}
