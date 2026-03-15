import { streamText, convertToModelMessages } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { createClient } from "@supabase/supabase-js";

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

export async function POST(req: Request) {
  const { messages } = await req.json();

  const [agentConfig, appConfig] = await Promise.all([
    getAgentConfig(),
    getAppConfig(),
  ]);

  const systemPrompt = agentConfig?.system_prompt ||
    `You are ${appConfig?.persona || "an AI assistant"}. ${appConfig?.description || ""} Answer questions helpfully and concisely based on the available data.`;

  const sourceTables: string[] = agentConfig?.source_tables || [];

  // Fetch data from source tables and include in system prompt as context
  let dataContext = "";
  for (const table of sourceTables.slice(0, 5)) {
    const { data } = await supabase.from(table).select("*").limit(50);
    if (data && data.length > 0) {
      dataContext += `\n\n## Data from '${table}' (${data.length} rows):\n${JSON.stringify(data, null, 2)}`;
    }
  }

  const citationGuidance = `\n\nWhen referencing specific data points, cite your sources inline using bold markers like **[Source: table_name — specific detail]**. This helps users verify your claims against the actual data.`;

  const fullSystemPrompt = dataContext
    ? `${systemPrompt}\n\nYou have access to the following data. Use it to answer questions accurately. When the user provides context about a specific record they're viewing, prioritize that record in your answers.${citationGuidance}${dataContext}`
    : systemPrompt;

  const result = streamText({
    model: anthropic(agentConfig?.model || "claude-sonnet-4-20250514"),
    system: fullSystemPrompt,
    messages: await convertToModelMessages(messages),
  });

  return result.toUIMessageStreamResponse();
}
