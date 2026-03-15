export const maxDuration = 60;

import { createClient } from "@supabase/supabase-js";
import { runPipeline } from "../_lib/pipeline";
import type {
  FormConfig,
  WorkflowConfig,
  ExtractionSchema,
  ValidationRulesConfig,
  OutputSectionsConfig,
  PipelineConfig,
  PipelinePrompts,
} from "@/lib/types";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SECRET_KEY!
);

async function getAppConfig() {
  const { data } = await supabase
    .from("app_config")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(1)
    .single();
  return data;
}

async function getAgentConfig() {
  const { data } = await supabase
    .from("agent_config")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(1)
    .single();
  return data;
}

export async function POST(req: Request) {
  const body = await req.json();
  const formData: Record<string, string> = body.data;

  if (!formData || typeof formData !== "object") {
    return Response.json({ success: false, error: "Missing form data" }, { status: 400 });
  }

  const [appConfig, agentConfig] = await Promise.all([
    getAppConfig(),
    getAgentConfig(),
  ]);

  const formConfig = appConfig?.form_config as FormConfig | null;
  if (!formConfig) {
    return Response.json({ success: false, error: "No form configuration found" }, { status: 400 });
  }

  // Server-side validation
  for (const section of formConfig.sections) {
    for (const field of section.fields) {
      const v = formData[field.name] || "";
      if (field.required && !v.trim()) {
        return Response.json(
          { success: false, error: `${field.label} is required` },
          { status: 400 }
        );
      }
    }
  }

  // Insert into target table
  const targetTable = formConfig.target_table;

  // Convert numeric fields
  const row: Record<string, unknown> = {};
  for (const section of formConfig.sections) {
    for (const field of section.fields) {
      const v = formData[field.name];
      if (v === undefined || v === "") continue;
      if (field.type === "number") {
        row[field.name] = Number(v);
      } else if (field.type === "checkbox") {
        row[field.name] = v === "true";
      } else {
        row[field.name] = v;
      }
    }
  }

  // If this table is also a workflow item table, auto-set the initial stage
  const workflowConfig = agentConfig?.workflow_config as WorkflowConfig | null;
  if (
    workflowConfig &&
    workflowConfig.item_table === targetTable &&
    workflowConfig.initial_stage
  ) {
    row.stage = workflowConfig.initial_stage;
  }

  const { data: inserted, error: insertError } = await supabase
    .from(targetTable)
    .insert(row)
    .select("id")
    .single();

  if (insertError) {
    console.error("Insert error:", insertError);
    return Response.json(
      { success: false, error: "Failed to save data" },
      { status: 500 }
    );
  }

  const itemId = inserted?.id;

  // Optionally run pipeline on submitted data
  let pipelineResults = null;
  if (formConfig.post_submit_pipeline && agentConfig) {
    const hasPipeline =
      agentConfig.extraction_schema?.fields?.length > 0 ||
      agentConfig.pipeline_config?.steps?.length > 0;

    if (hasPipeline) {
      try {
        const documentText = Object.entries(formData)
          .map(([k, v]) => `${k}: ${v}`)
          .join("\n");

        // Fetch reference data from source tables
        const sourceTables: string[] = agentConfig.source_tables || [];
        const referenceData: Record<string, unknown[]> = {};
        for (const table of sourceTables.slice(0, 5)) {
          const { data } = await supabase.from(table).select("*").limit(50);
          if (data && data.length > 0) {
            referenceData[table] = data;
          }
        }

        pipelineResults = await runPipeline({
          documentText,
          systemPrompt: agentConfig.system_prompt || "You are a data analyst.",
          model: agentConfig.model || "claude-sonnet-4-20250514",
          extractionSchema: (agentConfig.extraction_schema as ExtractionSchema) || null,
          validationRules: (agentConfig.validation_rules as ValidationRulesConfig) || null,
          outputSections: (agentConfig.output_sections as OutputSectionsConfig) || null,
          pipelineConfig: (agentConfig.pipeline_config as PipelineConfig) || null,
          pipelinePrompts: (agentConfig.pipeline_prompts as PipelinePrompts) || null,
          referenceData,
        });

        // Persist pipeline results linked to the item
        if (itemId && pipelineResults) {
          const scoreSection = pipelineResults.sections.find((s: { type: string }) => s.type === "score");
          const score = scoreSection ? (scoreSection.data as { score?: number })?.score : null;
          await supabase.from("pipeline_results").insert({
            item_id: itemId,
            item_table: targetTable,
            sections: pipelineResults.sections,
            score,
            metadata: pipelineResults.metadata,
          }).then(() => {}, () => {});
        }
      } catch (e) {
        console.error("Post-submit pipeline error:", e);
      }
    }
  }

  // Write to dashboard_updates for real-time refresh
  await supabase.from("dashboard_updates").insert({
    component_id: "form_submission",
    data: { table: targetTable, item_id: itemId },
  }).then(() => {}, () => {});

  return Response.json({
    success: true,
    item_id: itemId,
    pipeline_results: pipelineResults,
  });
}
