export const maxDuration = 60;

import { createClient } from "@supabase/supabase-js";
import type { WorkflowConfig, WorkflowAction } from "@/lib/types";

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
  const body = await req.json();
  const { item_id, action_id, stage_id, notes } = body as {
    item_id: string;
    action_id: string;
    stage_id: string;
    notes?: string;
  };

  if (!item_id || !action_id || !stage_id) {
    return Response.json(
      { success: false, error: "Missing item_id, action_id, or stage_id" },
      { status: 400 }
    );
  }

  const agentConfig = await getAgentConfig();
  const workflowConfig = agentConfig?.workflow_config as WorkflowConfig | null;

  if (!workflowConfig) {
    return Response.json(
      { success: false, error: "No workflow configuration found" },
      { status: 400 }
    );
  }

  // Find the current stage
  const stage = workflowConfig.stages.find((s) => s.id === stage_id);
  if (!stage) {
    return Response.json(
      { success: false, error: `Unknown stage: ${stage_id}` },
      { status: 400 }
    );
  }

  // Find the action within this stage
  const action: WorkflowAction | undefined = stage.actions.find((a) => a.id === action_id);
  if (!action) {
    return Response.json(
      { success: false, error: `Action "${action_id}" is not valid for stage "${stage_id}"` },
      { status: 400 }
    );
  }

  const itemTable = workflowConfig.item_table;

  // Verify the item is actually in the expected stage
  const { data: item, error: fetchError } = await supabase
    .from(itemTable)
    .select("id, stage")
    .eq("id", item_id)
    .single();

  if (fetchError || !item) {
    return Response.json(
      { success: false, error: "Item not found" },
      { status: 404 }
    );
  }

  if (item.stage !== stage_id) {
    return Response.json(
      { success: false, error: `Item is in stage "${item.stage}", not "${stage_id}"` },
      { status: 400 }
    );
  }

  // Update the item's stage (+ any set_fields side-effect)
  const updatePayload: Record<string, unknown> = { stage: action.next_stage };
  if (action.side_effect?.type === "set_fields" && action.side_effect.fields) {
    Object.assign(updatePayload, action.side_effect.fields);
  }

  const { error: updateError } = await supabase
    .from(itemTable)
    .update(updatePayload)
    .eq("id", item_id);

  if (updateError) {
    console.error("Stage update error:", updateError);
    return Response.json(
      { success: false, error: "Failed to update item stage" },
      { status: 500 }
    );
  }

  // Execute webhook side-effect (fire-and-forget)
  if (action.side_effect?.type === "webhook" && action.side_effect.webhook_url) {
    fetch(action.side_effect.webhook_url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        item_id,
        action_id,
        from_stage: stage_id,
        to_stage: action.next_stage,
        ...(action.side_effect.webhook_body || {}),
      }),
    }).catch((e) => console.error("Webhook side-effect failed:", e));
  }

  // Write to activity_log
  await supabase
    .from("activity_log")
    .insert({
      action: `${action.label}: moved to "${action.next_stage}"${notes ? ` — ${notes}` : ""}`,
      item_id,
      stage_from: stage_id,
      stage_to: action.next_stage,
    })
    .then(() => {}, () => {});

  // Trigger dashboard refresh
  await supabase
    .from("dashboard_updates")
    .insert({
      component_id: "workflow_action",
      data: { item_id, action_id, from: stage_id, to: action.next_stage },
    })
    .then(() => {}, () => {});

  return Response.json({
    success: true,
    new_stage: action.next_stage,
  });
}
