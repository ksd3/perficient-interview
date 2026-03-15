export const maxDuration = 60;

import { createClient } from "@supabase/supabase-js";
import { runPipeline } from "../_lib/pipeline";
import type {
  ExtractionSchema,
  ValidationRulesConfig,
  OutputSectionsConfig,
  PipelineConfig,
  PipelinePrompts,
  WorkflowConfig,
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

export async function POST(req: Request) {
  const body = (await req.json()) as { item_id: string; table_name?: string };
  const { item_id, table_name } = body;

  if (!item_id) {
    return Response.json({ error: "Missing item_id" }, { status: 400 });
  }

  const agentConfig = await getAgentConfig();
  if (!agentConfig) {
    return Response.json({ error: "No agent configuration" }, { status: 400 });
  }

  // Resolve which table to fetch from: explicit table_name > workflow item_table
  const workflowConfig = agentConfig.workflow_config as WorkflowConfig | null;
  const itemTable = table_name || workflowConfig?.item_table;
  if (!itemTable) {
    return Response.json({ error: "No table specified and no workflow item table configured" }, { status: 400 });
  }

  // Validate table_name is in source_tables (prevent arbitrary table access)
  const sourceTables: string[] = agentConfig.source_tables || [];
  if (!sourceTables.includes(itemTable)) {
    return Response.json({ error: `Table '${itemTable}' not in source_tables` }, { status: 400 });
  }

  // Fetch the item
  const { data: item, error: fetchErr } = await supabase
    .from(itemTable)
    .select("*")
    .eq("id", item_id)
    .single();

  if (fetchErr || !item) {
    return Response.json({ error: "Item not found" }, { status: 404 });
  }

  // Build document text from the item, but also pull in related data from other tables
  const itemFields = Object.entries(item)
    .filter(([k]) => !["id", "created_at", "embedding"].includes(k))
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");

  // Look for related records in other source tables (FK pattern: {singular}_id)
  const singularTable = itemTable.replace(/s$/, "");
  const fkCandidates = [`${singularTable}_id`, `${itemTable}_id`];
  const relatedSections: string[] = [];

  for (const otherTable of sourceTables) {
    if (otherTable === itemTable) continue;
    for (const fk of fkCandidates) {
      try {
        const { data: related } = await supabase
          .from(otherTable)
          .select("*")
          .eq(fk, item_id)
          .limit(20);
        if (related && related.length > 0) {
          const header = otherTable.replace(/_/g, " ").replace(/\b\w/g, (c: string) => c.toUpperCase());
          const rows = related.map((r) =>
            Object.entries(r)
              .filter(([k]) => !["id", "created_at", "embedding", fk].includes(k))
              .map(([k, v]) => `${k}: ${v}`)
              .join(", ")
          );
          relatedSections.push(`\n--- ${header} (${related.length} records) ---\n${rows.join("\n")}`);
          break;
        }
      } catch {
        // FK doesn't exist in this table
      }
    }
  }

  const documentText = `--- ${itemTable.replace(/_/g, " ").replace(/\b\w/g, (c: string) => c.toUpperCase())} Record ---\n${itemFields}${relatedSections.join("")}`;

  const model = agentConfig.model || "claude-sonnet-4-20250514";
  const systemPrompt = agentConfig.system_prompt || "You are a data analyst.";

  // Fetch reference data for context
  const referenceData: Record<string, unknown[]> = {};
  for (const table of sourceTables.slice(0, 5)) {
    const { data } = await supabase.from(table).select("*").limit(50);
    if (data && data.length > 0) {
      referenceData[table] = data;
    }
  }

  const hasPipeline =
    agentConfig.extraction_schema?.fields?.length > 0 ||
    agentConfig.pipeline_config?.steps?.length > 0;

  if (!hasPipeline) {
    return Response.json({ error: "No pipeline configured" }, { status: 400 });
  }

  // Pre-populate extracted fields from the row data so the rule engine works
  // even if LLM extraction fails or returns partial results
  const preExtracted: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(item)) {
    if (!["id", "created_at", "embedding", "stage"].includes(k) && v !== null) {
      preExtracted[k] = v;
    }
  }

  try {
    const result = await runPipeline({
      documentText,
      systemPrompt,
      model,
      extractionSchema: (agentConfig.extraction_schema as ExtractionSchema) || null,
      validationRules: (agentConfig.validation_rules as ValidationRulesConfig) || null,
      outputSections: (agentConfig.output_sections as OutputSectionsConfig) || null,
      pipelineConfig: (agentConfig.pipeline_config as PipelineConfig) || null,
      pipelinePrompts: (agentConfig.pipeline_prompts as PipelinePrompts) || null,
      referenceData,
      preExtracted,
    });

    // Persist linked to the item
    const scoreSection = result.sections.find((s) => s.type === "score");
    const score = scoreSection ? (scoreSection.data as { score?: number })?.score : null;
    await supabase
      .from("pipeline_results")
      .insert({
        item_id,
        item_table: itemTable,
        sections: result.sections,
        score,
        metadata: result.metadata,
      })
      .then(() => {}, () => {});

    return Response.json({ success: true, ...result });
  } catch (e) {
    console.error("Analyze-item pipeline error:", e);
    return Response.json(
      { error: "Pipeline failed", sections: [], metadata: { pipeline_steps: [], duration_ms: 0 } },
      { status: 500 }
    );
  }
}
