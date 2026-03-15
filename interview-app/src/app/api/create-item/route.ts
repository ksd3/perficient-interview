import { createClient } from "@supabase/supabase-js";
import type { WorkflowConfig } from "@/lib/types";

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
  const { fields, sections } = (await req.json()) as {
    fields: Record<string, unknown>;
    sections: unknown[];
  };

  const agentConfig = await getAgentConfig();
  const workflowConfig = agentConfig?.workflow_config as WorkflowConfig | null;

  if (!workflowConfig?.item_table || !workflowConfig?.initial_stage) {
    return Response.json(
      { success: false, error: "No workflow configured" },
      { status: 400 }
    );
  }

  const itemTable = workflowConfig.item_table;

  // Discover valid columns by fetching one row from the table
  const { data: sampleRows } = await supabase
    .from(itemTable)
    .select("*")
    .limit(1);
  const knownColumns = sampleRows && sampleRows.length > 0
    ? new Set(Object.keys(sampleRows[0]))
    : null;

  // Build the row: extracted fields + initial stage (only known columns)
  const row: Record<string, unknown> = {
    stage: workflowConfig.initial_stage,
  };

  for (const [key, value] of Object.entries(fields || {})) {
    if (key === "id" || key === "created_at") continue;
    // If we know the columns, only insert matching ones
    if (knownColumns && !knownColumns.has(key)) continue;
    row[key] = value;
  }

  const { data: inserted, error: insertError } = await supabase
    .from(itemTable)
    .insert(row)
    .select("id")
    .single();

  if (insertError) {
    console.error("Create item error:", insertError);
    return Response.json(
      { success: false, error: `Failed to create item: ${insertError.message}` },
      { status: 500 }
    );
  }

  const itemId = inserted?.id;

  // Save pipeline results linked to new item
  if (itemId && sections) {
    const scoreSection = (sections as { type: string; data?: { score?: number } }[]).find(
      (s) => s.type === "score"
    );
    const score = scoreSection?.data?.score ?? null;
    await supabase
      .from("pipeline_results")
      .insert({
        item_id: itemId,
        item_table: itemTable,
        sections,
        score,
        metadata: { source: "document_upload" },
      })
      .then(() => {}, () => {});
  }

  // Trigger dashboard/workflow refresh
  await supabase
    .from("dashboard_updates")
    .insert({
      component_id: "item_created",
      data: { table: itemTable, item_id: itemId },
    })
    .then(() => {}, () => {});

  return Response.json({ success: true, item_id: itemId });
}
