export const maxDuration = 60;

import { generateText } from "ai";
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
  const { query } = await req.json();

  if (!query || typeof query !== "string" || !query.trim()) {
    return Response.json({ error: "Missing research query" }, { status: 400 });
  }

  const [agentConfig, appConfig] = await Promise.all([
    getAgentConfig(),
    getAppConfig(),
  ]);

  const persona = agentConfig?.persona || appConfig?.persona || "a research analyst";
  const sourceTables: string[] = agentConfig?.source_tables || [];

  // Fetch data from source tables as research context
  let dataContext = "";
  for (const table of sourceTables.slice(0, 5)) {
    const { data } = await supabase.from(table).select("*").limit(50);
    if (data && data.length > 0) {
      dataContext += `\n\n## Data from '${table}' (${data.length} rows):\n${JSON.stringify(data, null, 2)}`;
    }
  }

  const systemPrompt = agentConfig?.system_prompt ||
    `You are ${persona}. You research topics thoroughly and produce detailed reports.`;

  const fullSystemPrompt = `${systemPrompt}

You are a research assistant. Given a query, produce a comprehensive research report with sources.

Return your response as a JSON object with this exact structure:
{
  "report": "A detailed multi-paragraph research report in plain text",
  "sources": [
    { "title": "Source title", "snippet": "Brief description of what this source covers" },
    { "title": "Another source", "url": "https://example.com", "snippet": "Description" }
  ]
}

For sources: use the data tables as primary sources (reference them by table name). You may also cite general domain knowledge as sources. Include 3-8 sources.

IMPORTANT: Return ONLY valid JSON. No markdown, no code fences, no explanation outside the JSON.${dataContext ? `\n\nYou have access to the following data for your research:${dataContext}` : ""}`;

  try {
    // Step 1: Web search for real-time context
    let webContext = "";
    const webSources: Array<{ title: string; url?: string; snippet: string }> = [];
    try {
      const searchResult = await generateText({
        model: anthropic(agentConfig?.model || "claude-sonnet-4-20250514"),
        tools: {
          web_search: anthropic.tools.webSearch_20250305({ maxUses: 3 }),
        },
        system: "Search the web for the most relevant, current information on this topic. Synthesize findings concisely.",
        prompt: query.trim(),
        abortSignal: AbortSignal.timeout(20_000),
      });

      webContext = `\n\nWeb research findings:\n${searchResult.text}`;

      if (searchResult.sources && Array.isArray(searchResult.sources)) {
        for (const source of searchResult.sources) {
          if (source.sourceType === "url") {
            webSources.push({
              title: ("title" in source && typeof source.title === "string" ? source.title : "") || "Web Source",
              url: source.url,
              snippet: "",
            });
          }
        }
      }
    } catch (e) {
      console.error("Research web search failed (continuing with data only):", e);
    }

    // Step 2: Generate report combining web research + domain data
    const { text } = await generateText({
      model: anthropic(agentConfig?.model || "claude-sonnet-4-20250514"),
      system: fullSystemPrompt + webContext,
      prompt: `Research the following topic and produce a detailed report:\n\n${query.trim()}`,
      abortSignal: AbortSignal.timeout(25_000),
    });

    let report = "";
    let sources: Array<{ title: string; url?: string; snippet: string }> = [];

    // Try to parse as JSON first
    const cleaned = text.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
    try {
      const result = JSON.parse(cleaned);
      report = result.report || "";
      sources = result.sources || [];
    } catch {
      // If not valid JSON, use the raw text as the report
      report = text;
    }

    // Merge web sources with LLM-cited sources
    if (webSources.length > 0) {
      const existingUrls = new Set(sources.map((s) => s.url).filter(Boolean));
      for (const ws of webSources) {
        if (ws.url && !existingUrls.has(ws.url)) {
          sources.push(ws);
        }
      }
    }

    return Response.json({ report, sources });
  } catch (e) {
    console.error("Research error:", e);
    return Response.json(
      { report: "Research failed. Please try again.", sources: [] },
      { status: 500 }
    );
  }
}
