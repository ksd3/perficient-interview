"use client";

import { SectionRenderer } from "@/components/sections/SectionRenderer";
import type { OutputSection } from "@/lib/types";

export function PipelineResultsPanel({ sections }: { sections: OutputSection[] }) {
  if (sections.length === 0) {
    return (
      <p className="text-center text-sm text-muted-foreground py-8">
        No analysis results yet. Upload and analyze a document to see results here.
      </p>
    );
  }

  return <SectionRenderer sections={sections} />;
}
