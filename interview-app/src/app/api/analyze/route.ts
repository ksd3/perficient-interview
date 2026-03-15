export const maxDuration = 60;

import { generateText } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { createClient } from "@supabase/supabase-js";
import { extractText as extractPdfText } from "unpdf";
import { runPipeline } from "../_lib/pipeline";
import type {
  ExtractionSchema,
  ValidationRulesConfig,
  OutputSectionsConfig,
  PipelineConfig,
  PipelinePrompts,
  OutputSection,
  KVPairsData,
} from "@/lib/types";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SECRET_KEY!
);

async function getAgentConfig() {
  const { data } = await supabase
    .from("agent_config")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(1)
    .single();
  return data;
}

async function getAppConfig() {
  const { data } = await supabase
    .from("app_config")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(1)
    .single();
  return data;
}

async function extractFileContent(file: File): Promise<string> {
  const arrayBuffer = await file.arrayBuffer();
  if (file.name.endsWith(".pdf")) {
    const { text: pdfPages } = await extractPdfText(new Uint8Array(arrayBuffer));
    return pdfPages.join("\n");
  }
  return Buffer.from(arrayBuffer).toString("utf-8");
}

async function extractDocumentText(formData: FormData): Promise<string> {
  const additionalContext = (formData.get("document") as string | null)?.trim() || "";

  // Support multiple files: "file" (single) or "files" (multiple)
  const parts: string[] = [];
  const singleFile = formData.get("file") as File | null;
  const allFiles = formData.getAll("files") as File[];

  const filesToProcess = singleFile ? [singleFile] : allFiles;

  for (const file of filesToProcess) {
    if (!file || !file.name) continue;
    const content = await extractFileContent(file);
    if (filesToProcess.length > 1) {
      parts.push(`--- File: ${file.name} ---\n${content}`);
    } else {
      parts.push(content);
    }
  }

  const fileContent = parts.join("\n\n");

  if (!fileContent && !additionalContext) {
    throw new Error("No file or text provided");
  }

  if (fileContent && additionalContext) {
    return `${fileContent}\n\n--- Additional Context ---\n${additionalContext}`;
  }

  return fileContent || additionalContext;
}

export async function POST(req: Request) {
  let documentText: string;

  const contentType = req.headers.get("content-type") || "";

  try {
    if (contentType.includes("multipart/form-data")) {
      const formData = await req.formData();
      documentText = await extractDocumentText(formData);
    } else {
      const body = await req.json();
      documentText = body.document;
    }
  } catch {
    return Response.json({ error: "Could not read document" }, { status: 400 });
  }

  if (!documentText || typeof documentText !== "string" || !documentText.trim()) {
    return Response.json({ error: "Missing document text" }, { status: 400 });
  }

  const [agentConfig, appConfig] = await Promise.all([
    getAgentConfig(),
    getAppConfig(),
  ]);

  const persona = agentConfig?.persona || appConfig?.persona || "a document analyst";
  const model = agentConfig?.model || "claude-sonnet-4-20250514";
  const sourceTables: string[] = agentConfig?.source_tables || [];

  // Fetch reference data from source tables
  const referenceData: Record<string, unknown[]> = {};
  for (const table of sourceTables.slice(0, 5)) {
    const { data } = await supabase.from(table).select("*").limit(50);
    if (data && data.length > 0) {
      referenceData[table] = data;
    }
  }

  const systemPrompt = agentConfig?.system_prompt ||
    `You are ${persona}. You analyze documents and return structured findings.`;

  // Check if we have pipeline config — use new pipeline, otherwise fallback
  const hasPipeline = agentConfig?.extraction_schema?.fields?.length > 0 ||
    agentConfig?.pipeline_config?.steps?.length > 0;

  if (hasPipeline) {
    try {
      const result = await runPipeline({
        documentText,
        systemPrompt,
        model,
        extractionSchema: (agentConfig?.extraction_schema as ExtractionSchema) || null,
        validationRules: (agentConfig?.validation_rules as ValidationRulesConfig) || null,
        outputSections: (agentConfig?.output_sections as OutputSectionsConfig) || null,
        pipelineConfig: (agentConfig?.pipeline_config as PipelineConfig) || null,
        pipelinePrompts: (agentConfig?.pipeline_prompts as PipelinePrompts) || null,
        referenceData,
      });

      // Persist pipeline results (document uploads aren't linked to items)
      const scoreSection = result.sections.find((s) => s.type === "score");
      const score = scoreSection ? (scoreSection.data as { score?: number })?.score : null;
      await supabase.from("pipeline_results").insert({
        item_id: null,
        item_table: null,
        sections: result.sections,
        score,
        metadata: result.metadata,
      }).then(() => {}, () => {});

      return Response.json(result);
    } catch (e) {
      console.error("Pipeline error:", e);
      return Response.json(
        { error: "Pipeline failed", sections: [], metadata: { pipeline_steps: [], duration_ms: 0 } },
        { status: 500 }
      );
    }
  }

  // Build data context for legacy fallback
  let dataContext = "";
  for (const [table, rows] of Object.entries(referenceData)) {
    dataContext += `\n\n## Reference data from '${table}' (${(rows as unknown[]).length} rows):\n${JSON.stringify(rows, null, 2)}`;
  }
  const fullSystemPrompt = `${systemPrompt}${dataContext ? `\n\nYou have access to the following reference data for cross-referencing:${dataContext}` : ""}`;

  // Fallback: single Claude call, wrap in kv_pairs section
  try {
    const { text } = await generateText({
      model: anthropic(model),
      system: `${fullSystemPrompt}\n\nYou analyze documents submitted by users. Return your analysis as a JSON object with string values.\nInclude relevant fields such as: summary, key_findings, risk_level, status, recommendations.\n\nIMPORTANT: Return ONLY valid JSON. No markdown, no code fences.`,
      prompt: `Analyze the following document:\n\n${documentText}`,
    });

    const cleaned = text.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
    const analysis = JSON.parse(cleaned);

    // Wrap legacy flat JSON into sections format
    const sections: OutputSection[] = [
      {
        id: "analysis",
        type: "kv_pairs",
        title: "Analysis Results",
        data: { pairs: analysis } as KVPairsData,
      },
    ];

    return Response.json({
      sections,
      metadata: { pipeline_steps: ["legacy_single_call"], duration_ms: 0 },
    });
  } catch (e) {
    console.error("Analysis error:", e);
    return Response.json(
      { error: "Analysis failed", sections: [], metadata: { pipeline_steps: [], duration_ms: 0 } },
      { status: 500 }
    );
  }
}
