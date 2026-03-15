export const maxDuration = 60;

import { generateText } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SECRET_KEY!
);

export async function POST(req: Request) {
  const { instruction } = await req.json();

  if (!instruction || typeof instruction !== "string" || !instruction.trim()) {
    return Response.json({ error: "Missing instruction" }, { status: 400 });
  }

  // Fetch current configs
  const [{ data: appConfig }, { data: agentConfig }] = await Promise.all([
    supabase.from("app_config").select("*").order("created_at", { ascending: false }).limit(1).single(),
    supabase.from("agent_config").select("*").order("created_at", { ascending: false }).limit(1).single(),
  ]);

  if (!appConfig || !agentConfig) {
    return Response.json({ error: "No configuration found" }, { status: 400 });
  }

  // Ask Claude to generate a targeted patch
  const { text } = await generateText({
    model: anthropic(agentConfig.model || "claude-sonnet-4-20250514"),
    maxOutputTokens: 4096,
    abortSignal: AbortSignal.timeout(20_000),
    system: `You modify AI application configurations based on natural language instructions.

You will receive the current app_config and agent_config, plus a user instruction. Generate a JSON patch that modifies ONLY the relevant parts.

Return ONLY valid JSON with this structure:
{
  "app_config_patch": { ... fields to merge into app_config ... },
  "agent_config_patch": { ... fields to merge into agent_config ... },
  "description": "Brief description of what was changed"
}

RULES:
- Only include fields that need to change. Omit unchanged fields.
- For array fields (kpi_config, chart_config, quick_actions, validation_rules.rules, pipeline_config.steps, output_sections.sections), return the FULL array with your additions/changes included.
- For nested objects (extraction_schema, form_config), return the full object with modifications.
- Keep existing items intact unless the instruction says to remove them.
- Use real domain-appropriate values (real thresholds, real field names that match the extraction_schema).
- If adding a validation rule, ensure the field it references exists in extraction_schema. If not, add it there too.
- If adding a KPI, ensure the table and field exist in source_tables.
- To change colors/theme, set the "theme" field in app_config_patch. Use oklch() CSS color values. Example: {"theme": {"primary": "oklch(0.6 0.25 30)"}} for red, {"theme": {"primary": "oklch(0.55 0.20 145)"}} for green. Available theme keys: primary, background, card, foreground, accent.`,
    prompt: `Current app_config:
${JSON.stringify(appConfig, null, 2)}

Current agent_config (excluding system_prompt for brevity):
${JSON.stringify({ ...agentConfig, system_prompt: "[omitted]" }, null, 2)}

User instruction: "${instruction.trim()}"

Generate the minimal patch to implement this change.`,
  });

  // Parse the patch
  let patch;
  try {
    const cleaned = text.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    patch = JSON.parse(cleaned.slice(start, end + 1));
  } catch (e) {
    console.error("Customize: failed to parse patch:", e);
    return Response.json({ error: "Could not generate a valid configuration change" }, { status: 500 });
  }

  // Apply patches
  const changes: string[] = [];

  if (patch.app_config_patch && Object.keys(patch.app_config_patch).length > 0) {
    const updated = { ...appConfig, ...patch.app_config_patch };
    // Remove fields Supabase manages
    delete updated.id;
    delete updated.created_at;
    await supabase.from("app_config").update(updated).eq("id", appConfig.id).then(() => {}, () => {});
    changes.push("app_config");
  }

  if (patch.agent_config_patch && Object.keys(patch.agent_config_patch).length > 0) {
    const updated = { ...agentConfig, ...patch.agent_config_patch };
    delete updated.id;
    delete updated.created_at;
    await supabase.from("agent_config").update(updated).eq("id", agentConfig.id).then(() => {}, () => {});
    changes.push("agent_config");
  }

  // Trigger UI refresh
  if (changes.length > 0) {
    await supabase.from("dashboard_updates").insert({
      component_id: "full_reconfigure",
      data: { source: "customize", changes, description: patch.description },
    }).then(() => {}, () => {});
  }

  return Response.json({
    success: true,
    description: patch.description || "Configuration updated",
    changes,
  });
}
