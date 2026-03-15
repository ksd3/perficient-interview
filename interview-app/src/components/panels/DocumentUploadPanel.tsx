"use client";

import { useState, useRef, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { SectionRenderer } from "@/components/sections/SectionRenderer";
import type { AppConfig, OutputSection, FieldTableData } from "@/lib/types";
import { ProcessingIndicator } from "@/components/ui/processing-indicator";
import { createClient } from "@/lib/supabase";

interface ExtractionField {
  name: string;
  type: string;
  description: string;
  required?: boolean;
}

export function DocumentUploadPanel({
  config,
  onResults,
  hasWorkflow = false,
}: {
  config: AppConfig;
  onResults?: (sections: OutputSection[]) => void;
  hasWorkflow?: boolean;
} = {} as { config: AppConfig }) {
  const [documentText, setDocumentText] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [sections, setSections] = useState<OutputSection[] | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [addingToWorkflow, setAddingToWorkflow] = useState(false);
  const [addedToWorkflow, setAddedToWorkflow] = useState(false);
  const [workflowError, setWorkflowError] = useState<string | null>(null);
  const [extractionFields, setExtractionFields] = useState<ExtractionField[]>([]);
  const [recentCount, setRecentCount] = useState(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const supabase = createClient();

  // Fetch agent_config for extraction hints and recent analysis count
  useEffect(() => {
    async function fetchContext() {
      const { data: ac } = await supabase
        .from("agent_config")
        .select("extraction_schema")
        .order("created_at", { ascending: false })
        .limit(1)
        .single();
      if (ac?.extraction_schema?.fields) {
        setExtractionFields(ac.extraction_schema.fields);
      }
      const { count } = await supabase
        .from("pipeline_results")
        .select("*", { count: "exact", head: true });
      setRecentCount(count ?? 0);
    }
    fetchContext();
  }, []);

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const selected = Array.from(e.target.files || []);
    if (selected.length === 0) return;
    setFiles((prev) => [...prev, ...selected]);
  }

  function removeFile(index: number) {
    setFiles((prev) => prev.filter((_, i) => i !== index));
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  function clearFiles() {
    setFiles([]);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  async function analyzeDocument() {
    if (files.length === 0 && !documentText.trim()) return;
    setIsAnalyzing(true);
    setAddedToWorkflow(false);
    setWorkflowError(null);
    try {
      let res: Response;

      if (files.length > 0) {
        const formData = new FormData();
        if (files.length === 1) {
          formData.append("file", files[0]);
        } else {
          for (const f of files) {
            formData.append("files", f);
          }
        }
        if (documentText.trim()) {
          formData.append("document", documentText.trim());
        }
        res = await fetch("/api/analyze", {
          method: "POST",
          body: formData,
        });
      } else {
        res = await fetch("/api/analyze", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ document: documentText }),
        });
      }

      if (res.ok) {
        const data = await res.json();
        if (data.sections) {
          setSections(data.sections);
          onResults?.(data.sections);
          setRecentCount((c) => c + 1);
        } else {
          setSections([
            {
              id: "analysis",
              type: "kv_pairs",
              title: "Analysis Results",
              data: { pairs: data },
            },
          ]);
        }
      } else {
        setSections([
          {
            id: "error",
            type: "text",
            title: "Error",
            data: { content: "Analysis failed. Please try again." },
          },
        ]);
      }
    } catch {
      setSections([
        {
          id: "error",
          type: "text",
          title: "Error",
          data: { content: "Analysis failed. Please try again." },
        },
      ]);
    } finally {
      setIsAnalyzing(false);
    }
  }

  async function addToWorkflow() {
    if (!sections) return;
    setAddingToWorkflow(true);
    try {
      const fieldSection = sections.find((s) => s.type === "field_table");
      const fields = fieldSection
        ? (fieldSection.data as FieldTableData).fields.reduce(
            (acc, f) => ({ ...acc, [f.name]: f.value }),
            {} as Record<string, unknown>
          )
        : {};
      const scoreSection = sections.find((s) => s.type === "score");
      const score = scoreSection ? (scoreSection.data as { score?: number })?.score : undefined;
      if (score !== undefined) {
        fields.risk_score = score;
      }

      const res = await fetch("/api/create-item", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fields, sections }),
      });
      if (res.ok) {
        setAddedToWorkflow(true);
        setWorkflowError(null);
      } else {
        const data = await res.json().catch(() => ({}));
        setWorkflowError(data.error || "Failed to add to workflow");
      }
    } finally {
      setAddingToWorkflow(false);
    }
  }

  const hasInput = files.length > 0 || !!documentText.trim();

  // Build contextual description from extraction fields
  const fieldHints = extractionFields.slice(0, 6).map((f) => f.description || f.name);

  return (
    <div className="flex flex-col gap-5">
      {/* Contextual header */}
      <div>
        <h2 className="text-base font-bold tracking-tight">{config?.title || "Document Analysis"}</h2>
        {config?.description && (
          <p className="text-sm text-muted-foreground/70 mt-1 leading-relaxed">{config.description}</p>
        )}
      </div>

      {/* Document Input */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="text-sm font-semibold">Upload or Paste Document</CardTitle>
            {recentCount > 0 && (
              <Badge variant="secondary" className="text-[10px]">{recentCount} analyzed</Badge>
            )}
          </div>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {/* What the AI will look for */}
          {fieldHints.length > 0 && (
            <div className="rounded-xl bg-primary/[0.03] border border-primary/10 px-4 py-3">
              <p className="text-[11px] font-semibold text-primary/70 uppercase tracking-wider mb-1.5">What the AI will analyze</p>
              <div className="flex flex-wrap gap-1.5">
                {fieldHints.map((hint, i) => (
                  <span key={i} className="text-[11px] text-muted-foreground/70 bg-background rounded-lg px-2 py-0.5 border border-border/30">
                    {hint}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* File Upload */}
          <div className="flex items-center gap-3">
            <input
              ref={fileInputRef}
              type="file"
              accept=".pdf,.txt,.md,.csv,.json,.xml,.html"
              multiple
              onChange={handleFileChange}
              className="hidden"
            />
            <Button
              variant="outline"
              size="sm"
              onClick={() => fileInputRef.current?.click()}
            >
              Upload File{files.length > 0 ? "s" : ""}
            </Button>
            {files.length === 0 && (
              <span className="text-xs text-muted-foreground/70">
                PDF, TXT, MD, CSV, JSON, XML, HTML
              </span>
            )}
          </div>

          {/* File list */}
          {files.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {files.map((f, i) => (
                <div key={`${f.name}-${i}`} className="flex items-center gap-1.5">
                  <Badge variant="secondary" className="rounded-lg">{f.name}</Badge>
                  <button
                    onClick={() => removeFile(i)}
                    className="text-xs text-muted-foreground hover:text-foreground transition-colors"
                  >
                    x
                  </button>
                </div>
              ))}
              {files.length > 1 && (
                <button
                  onClick={clearFiles}
                  className="text-xs text-muted-foreground hover:text-foreground transition-colors"
                >
                  Clear all
                </button>
              )}
            </div>
          )}

          {/* Divider */}
          <div className="flex items-center gap-4">
            <div className="h-px flex-1 bg-border/60" />
            <span className="text-[11px] text-muted-foreground/60 uppercase tracking-wider font-medium">
              {files.length > 0 ? "add context" : "or paste text below"}
            </span>
            <div className="h-px flex-1 bg-border/60" />
          </div>

          {/* Text Input */}
          <textarea
            className="min-h-[200px] w-full rounded-xl border border-border/40 bg-muted/30 p-5 text-[14px] leading-relaxed outline-none transition-all duration-200 focus-visible:border-primary/40 focus-visible:ring-3 focus-visible:ring-primary/10 placeholder:text-muted-foreground/40"
            placeholder={
              files.length > 0
                ? "Add additional context or instructions (e.g., 'Focus on compliance issues' or 'Compare against latest guidelines')..."
                : extractionFields.length > 0
                  ? `Paste the document text here, or upload a file above.\n\nYou can also add context alongside a file — for example, paste clinical notes and upload the authorization form together.\n\nThe AI will extract: ${extractionFields.slice(0, 4).map(f => f.name.replace(/_/g, ' ')).join(', ')}...`
                  : "Paste document text here, or upload a file above.\n\nYou can combine both — upload a file and add context or additional notes in this field."
            }
            value={documentText}
            onChange={(e) => setDocumentText(e.target.value)}
          />
          <Button onClick={analyzeDocument} disabled={isAnalyzing || !hasInput} className="self-start">
            {isAnalyzing ? "Analyzing..." : `Analyze${files.length > 1 ? ` ${files.length} Documents` : " Document"}`}
          </Button>
          {isAnalyzing && <ProcessingIndicator variant="analyze" />}
        </CardContent>
      </Card>

      {/* Analysis Results */}
      {sections && (
        <>
          <SectionRenderer sections={sections} />
          {hasWorkflow && sections.some((s) => s.type !== "text" || s.id !== "error") && (
            <div className="flex items-center gap-3">
              {!addedToWorkflow && (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={addingToWorkflow}
                  onClick={addToWorkflow}
                >
                  {addingToWorkflow ? "Adding..." : "Add to Workflow"}
                </Button>
              )}
              {addedToWorkflow && (
                <Badge variant="default" className="w-fit">Added to workflow</Badge>
              )}
              {workflowError && (
                <span className="text-xs text-red-500">{workflowError}</span>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
