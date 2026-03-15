import { generateText } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import type {
  ExtractionSchema,
  ValidationRulesConfig,
  ValidationRule,
  PipelineConfig,
  PipelinePrompts,
  OutputSectionsConfig,
  OutputSection,
  FieldTableData,
  ChecklistData,
  ScoreData,
  TextData,
  ListData,
  KVPairsData,
  DocumentData,
} from "@/lib/types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PipelineContext {
  documentText: string;
  systemPrompt: string;
  model: string;
  extractionSchema: ExtractionSchema | null;
  validationRules: ValidationRulesConfig | null;
  outputSections: OutputSectionsConfig | null;
  pipelineConfig: PipelineConfig | null;
  pipelinePrompts: PipelinePrompts | null;
  referenceData: Record<string, unknown[]>;
  // Accumulated results across steps
  extracted: Record<string, unknown>;
  ruleResults: ChecklistData["items"];
  score: number;
  scoreMax: number;
  scores: Record<string, { score: number; max: number; label: string }>;
  summaryText: string;
  summaryRecommendations: string[];
  generatedDocument: string;
  customOutputs: Record<string, string>;
  webSearchResults: Array<{ query: string; title: string; url: string; snippet: string }>;
  similarRecords: Array<Record<string, unknown>>;
  recordMatches: Array<{
    record_id: string;
    record_label: string;
    match_score: number;
    criteria_met: string[];
    criteria_unmet: string[];
    criteria_unclear: string[];
  }>;
  citations: Array<{ id: string; label: string; detail: string }>;
}

// ---------------------------------------------------------------------------
// Reference data formatter
// ---------------------------------------------------------------------------

// Per-step timeout (ms) — prevents any single LLM call from hanging the pipeline
const STEP_TIMEOUT_MS = 20_000;
const WEB_SEARCH_TIMEOUT_MS = 15_000; // tighter for individual web searches

function formatReferenceData(data: Record<string, unknown[]>, maxRows = 10): string {
  const parts: string[] = [];
  for (const [table, rows] of Object.entries(data)) {
    if (rows.length > 0) {
      const limited = rows.slice(0, maxRows);
      parts.push(`Reference '${table}' (${limited.length}/${rows.length} rows):\n${JSON.stringify(limited)}`);
    }
  }
  return parts.length > 0
    ? `\n\nReference data for cross-referencing:\n${parts.join("\n")}`
    : "";
}

function formatWebSearchResults(results: PipelineContext["webSearchResults"]): string {
  if (results.length === 0) return "";
  const items = results.map((r) =>
    `- ${r.title}${r.url ? ` (${r.url})` : ""}\n  ${r.snippet}`
  ).join("\n");
  return `\n\nRecent web search findings:\n${items}`;
}

// ---------------------------------------------------------------------------
// Expression evaluator (safe, no eval)
// Supports: numeric math, boolean fields, string fields, AND/OR compounds
// ---------------------------------------------------------------------------

type ExprValue = number | boolean | string;

type Token =
  | { type: "number"; value: number }
  | { type: "field"; value: string }
  | { type: "op"; value: string }
  | { type: "keyword"; value: string };

function tokenize(expr: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < expr.length) {
    if (/\s/.test(expr[i])) { i++; continue; }
    if (/[+\-*/()]/.test(expr[i])) {
      tokens.push({ type: "op", value: expr[i] });
      i++;
    } else if (/[0-9.]/.test(expr[i])) {
      let num = "";
      while (i < expr.length && /[0-9.]/.test(expr[i])) { num += expr[i]; i++; }
      tokens.push({ type: "number", value: parseFloat(num) });
    } else if (/[a-zA-Z_]/.test(expr[i])) {
      let name = "";
      while (i < expr.length && /[a-zA-Z0-9_]/.test(expr[i])) { name += expr[i]; i++; }
      // Recognize keywords
      if (name === "AND" || name === "OR") {
        tokens.push({ type: "keyword", value: name });
      } else if (name === "true") {
        tokens.push({ type: "number", value: 1 });
      } else if (name === "false") {
        tokens.push({ type: "number", value: 0 });
      } else {
        tokens.push({ type: "field", value: name });
      }
    } else {
      i++;
    }
  }
  return tokens;
}

/**
 * Resolve a single field to a numeric value for math expressions.
 * Booleans become 1/0. Strings that look numeric are parsed. Others throw.
 */
function resolveNumeric(val: unknown, fieldName: string): number {
  if (typeof val === "boolean") return val ? 1 : 0;
  if (typeof val === "number") return val;
  const n = Number(val);
  if (!isNaN(n)) return n;
  throw new Error(`Non-numeric field: ${fieldName} = ${val}`);
}

function evaluateTokens(tokens: Token[], fields: Record<string, unknown>): number {
  const resolved = tokens.map((t) => {
    if (t.type === "field") {
      const val = fields[t.value];
      if (val === undefined || val === null) throw new Error(`Missing field: ${t.value}`);
      return { type: "number" as const, value: resolveNumeric(val, t.value) };
    }
    return t;
  });

  const values: number[] = [];
  const ops: string[] = [];

  for (const token of resolved) {
    if (token.type === "number") {
      values.push(token.value);
      while (ops.length > 0 && (ops[ops.length - 1] === "*" || ops[ops.length - 1] === "/")) {
        const op = ops.pop()!;
        const b = values.pop()!;
        const a = values.pop()!;
        values.push(op === "*" ? a * b : a / b);
      }
    } else if (token.type === "op") {
      ops.push(token.value);
    }
  }

  let result = values[0] ?? 0;
  let vi = 1;
  for (const op of ops) {
    const b = values[vi++];
    if (op === "+") result += b;
    else if (op === "-") result -= b;
  }

  return result;
}

/**
 * Evaluate an expression that may contain AND/OR compound conditions.
 * Each sub-expression is separated by AND/OR and evaluated independently.
 * Returns the raw field value for simple field references (supports booleans/strings),
 * or a numeric result for math expressions.
 */
export function evaluateExpression(expression: string, fields: Record<string, unknown>): ExprValue {
  // Check for AND/OR compound — handled at the rule level, not here
  // For simple single-field references, return the raw value to support booleans/strings
  const trimmed = expression.trim();
  if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(trimmed)) {
    const val = fields[trimmed];
    if (val === undefined || val === null) throw new Error(`Missing field: ${trimmed}`);
    return val as ExprValue;
  }

  // Math expression
  const tokens = tokenize(trimmed);
  return evaluateTokens(tokens, fields);
}

// ---------------------------------------------------------------------------
// Compare helper — supports numeric, boolean, and string comparisons
// ---------------------------------------------------------------------------

function compare(
  value: ExprValue,
  operator: ValidationRule["operator"],
  threshold: number | string | boolean
): boolean {
  // Boolean operators work on the raw value
  if (operator === "is_true") {
    return value === true || value === 1 || value === "true";
  }
  if (operator === "is_false") {
    return value === false || value === 0 || value === "false";
  }
  if (operator === "exists") {
    return value !== undefined && value !== null;
  }

  // String "in" check: "emergent,urgent" → ["emergent", "urgent"]
  if (operator === "in") {
    const options = String(threshold).split(",").map((s) => s.trim().toLowerCase());
    return options.includes(String(value).toLowerCase());
  }

  // String equality
  if (operator === "eq" && (typeof value === "string" || typeof threshold === "string")) {
    return String(value).toLowerCase() === String(threshold).toLowerCase();
  }
  if (operator === "neq" && (typeof value === "string" || typeof threshold === "string")) {
    return String(value).toLowerCase() !== String(threshold).toLowerCase();
  }

  // Numeric comparisons
  const nv = typeof value === "boolean" ? (value ? 1 : 0) : Number(value);
  const nt = Number(threshold);
  if (isNaN(nv) || isNaN(nt)) return false;

  switch (operator) {
    case "eq": return nv === nt;
    case "neq": return nv !== nt;
    case "gt": return nv > nt;
    case "gte": return nv >= nt;
    case "lt": return nv < nt;
    case "lte": return nv <= nt;
    default: return false;
  }
}

/**
 * Evaluate a rule that may have AND/OR compound expressions.
 * Format: "field_a AND field_b > threshold" is split into sub-rules
 * that share the same operator/threshold.
 * Returns { passed, value } where value is from the last sub-expression.
 */
function evaluateRule(
  rule: ValidationRule,
  fields: Record<string, unknown>
): { passed: boolean; value: ExprValue } {
  const expr = rule.expression;

  // Check for AND/OR compounds
  const andParts = expr.split(/\bAND\b/i).map((s) => s.trim());
  if (andParts.length > 1) {
    let allPassed = true;
    let lastValue: ExprValue = 0;
    for (const part of andParts) {
      const val = evaluateExpression(part, fields);
      lastValue = val;
      if (!compare(val, rule.operator, rule.threshold)) {
        allPassed = false;
      }
    }
    return { passed: allPassed, value: lastValue };
  }

  const orParts = expr.split(/\bOR\b/i).map((s) => s.trim());
  if (orParts.length > 1) {
    let anyPassed = false;
    let lastValue: ExprValue = 0;
    for (const part of orParts) {
      const val = evaluateExpression(part, fields);
      lastValue = val;
      if (compare(val, rule.operator, rule.threshold)) {
        anyPassed = true;
      }
    }
    return { passed: anyPassed, value: lastValue };
  }

  // Simple expression
  const value = evaluateExpression(expr, fields);
  return { passed: compare(value, rule.operator, rule.threshold), value };
}

// ---------------------------------------------------------------------------
// Pipeline steps
// ---------------------------------------------------------------------------

function safeParseJSON(text: string): Record<string, unknown> | null {
  let cleaned = text.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    // Try to find the first { ... } block
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(cleaned.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

async function runLLMExtract(ctx: PipelineContext): Promise<void> {
  if (!ctx.extractionSchema || ctx.extractionSchema.fields.length === 0) return;

  const fieldDescriptions = ctx.extractionSchema.fields
    .map((f) => `- "${f.name}" (${f.type}${f.required ? ", required" : ""}): ${f.description}${f.options ? ` [options: ${f.options.join(", ")}]` : ""}`)
    .join("\n");

  const refContext = formatReferenceData(ctx.referenceData, 5);

  const extractSystem = ctx.pipelinePrompts?.extract_system
    || `Extract structured data from documents. Return ONLY valid JSON. If a field cannot be determined, use null. For boolean fields, cross-reference with any provided reference data.`;

  const { text } = await generateText({
    model: anthropic(ctx.model),
    maxOutputTokens: 2048,
    system: `${extractSystem}${refContext}`,
    prompt: `Extract these fields:\n${fieldDescriptions}\n\nDocument:\n${ctx.documentText.slice(0, 3000)}`,
    abortSignal: AbortSignal.timeout(STEP_TIMEOUT_MS),
  });

  const parsed = safeParseJSON(text);
  if (parsed) {
    // Merge with any pre-existing data (from row fields) — LLM values take precedence for non-null
    ctx.extracted = { ...ctx.extracted, ...Object.fromEntries(
      Object.entries(parsed).filter(([, v]) => v !== null && v !== undefined)
    )};
  } else {
    console.error("llm_extract: Could not parse LLM response as JSON, using pre-existing data");
  }
}

function runRuleEngine(ctx: PipelineContext): void {
  if (!ctx.validationRules || ctx.validationRules.rules.length === 0) return;

  for (const rule of ctx.validationRules.rules) {
    try {
      const { passed, value } = evaluateRule(rule, ctx.extracted);
      const displayValue = typeof value === "number"
        ? Math.round(value * 1000) / 1000
        : value;
      const message = passed
        ? undefined
        : rule.fail_message.replace(/\{\{value\}\}/g, String(displayValue));

      ctx.ruleResults.push({
        id: rule.id,
        label: rule.label,
        passed,
        severity: rule.severity,
        message,
        value: typeof value === "number" ? value : (typeof value === "boolean" ? (value ? 1 : 0) : 0),
      });
    } catch (e) {
      // Mark as skipped — not counted in scoring, only shown in checklist
      ctx.ruleResults.push({
        id: rule.id,
        label: rule.label,
        passed: false,
        severity: "info",
        message: `Skipped: ${(e as Error).message}`,
        skipped: true,
      } as ChecklistData["items"][number]);
    }
  }
}

function computeScore(ctx: PipelineContext, config?: Record<string, unknown>): void {
  const w = (config?.weights as Record<string, number>) ?? { critical: 3, warning: 1, info: 0 };
  const category = config?.category as string | undefined;
  const scoreId = config?.score_id as string | undefined;
  const scoreLabel = config?.label as string || (category ? `${category.charAt(0).toUpperCase() + category.slice(1)} Score` : "Overall Score");

  // Filter rules by category if specified, and always exclude skipped rules
  const allRules = ctx.ruleResults.filter((r) => !(r as Record<string, unknown>).skipped);
  const rules = category
    ? allRules.filter((r) => {
        const originalRule = ctx.validationRules?.rules.find((vr) => vr.id === r.id);
        return originalRule?.category === category;
      })
    : allRules;

  let totalWeight = 0;
  let earnedWeight = 0;

  for (const r of rules) {
    const ruleWeight = w[r.severity] ?? 1;
    totalWeight += ruleWeight;
    if (r.passed) earnedWeight += ruleWeight;
  }

  // This is the deterministic baseline score from rules alone.
  // It will be overridden by the LLM's holistic assessment in runLLMSummarize,
  // which considers the full context and produces scores consistent with the narrative.
  const score = totalWeight > 0 ? Math.round((earnedWeight / totalWeight) * 100) : 100;

  if (scoreId) {
    ctx.scores[scoreId] = { score, max: 100, label: scoreLabel };
  } else {
    ctx.scoreMax = 100;
    ctx.score = score;
  }
}

async function runLLMSummarize(ctx: PipelineContext): Promise<void> {
  const extractedSummary = Object.keys(ctx.extracted).length > 0
    ? `Extracted fields:\n${JSON.stringify(ctx.extracted)}`
    : "";

  const rulesSummary = ctx.ruleResults.length > 0
    ? `Rule-based checks:\n${ctx.ruleResults.map((r) => `- ${r.label}: ${r.passed ? "PASS" : "FAIL"}${r.message ? ` — ${r.message}` : ""}`).join("\n")}`
    : "";

  const webContext = formatWebSearchResults(ctx.webSearchResults);
  const similarContext = formatSimilarRecords(ctx.similarRecords);
  const matchContext = formatRecordMatches(ctx.recordMatches);

  const summarizeSystem = ctx.pipelinePrompts?.summarize_system
    || `You summarize document analyses. Be concise.`;

  // Build score assessment instructions if we have named score dimensions
  const scoreDimensions = Object.entries(ctx.scores);
  let scoresInstruction = "";
  let scoresFormat = "";

  if (scoreDimensions.length > 0) {
    const dimDescriptions = scoreDimensions.map(([id, s]) =>
      `- "${id}" (${s.label}): assess holistically from 0 to 100 where 100 = best/safest/healthiest and 0 = worst/highest risk/most urgent. Consider ALL available data, not just the rule checks.`
    ).join("\n");
    scoresInstruction = `\n\nIMPORTANT: You must also produce holistic scores for each dimension below. These scores should reflect the FULL picture from all the data — extracted fields, rule results, related records, web research, and your domain expertise. The rule-based checks above are narrow automated checks; your scores should be a more complete assessment.\n${dimDescriptions}`;
    scoresFormat = `, "scores": {${scoreDimensions.map(([id]) => `"${id}": <0-100>`).join(", ")}}`;
  } else if (ctx.ruleResults.length > 0) {
    // Single overall score
    scoresInstruction = `\n\nIMPORTANT: Also produce an overall "score" (0-100 where 100 = best/safest, 0 = worst/highest risk) that reflects your holistic assessment of the full picture, not just the automated rule checks.`;
    scoresFormat = `, "score": <0-100>`;
  }

  const { text } = await generateText({
    model: anthropic(ctx.model),
    maxOutputTokens: 2048,
    system: `${summarizeSystem}${scoresInstruction}

Return ONLY valid JSON:
{"summary": "paragraph with inline citations like [1][2]", "recommendations": ["item1", "item2"]${scoresFormat}, "sources": [{"id": "1", "label": "Short source description", "detail": "Specific data point cited"}]}

CITATION RULES:
- Use numbered inline citations [1], [2], etc. in your summary text to reference specific data points.
- Each citation must correspond to an entry in the "sources" array.
- Sources should reference specific records, tables, rule results, or web findings — not vague references.
- Example: "The data shows a significant finding at 40% [1], above the recommended threshold [2]."
- Include 3-8 sources that ground your key claims in verifiable data.

Your summary, recommendations, and scores MUST tell a consistent story. If you score something as high risk, explain why in the summary. If the summary highlights concerns, the scores should reflect that.${webContext}${similarContext}${matchContext}`,
    prompt: `Analyze and summarize:\n\n${extractedSummary}\n\n${rulesSummary}\n\nFull context:\n${ctx.documentText.slice(0, 2000)}`,
    abortSignal: AbortSignal.timeout(STEP_TIMEOUT_MS),
  });

  const parsed = safeParseJSON(text);
  if (parsed) {
    ctx.summaryText = (parsed.summary as string) || "";
    ctx.summaryRecommendations = (parsed.recommendations as string[]) || [];

    // Override named scores with LLM's holistic assessment
    if (parsed.scores && typeof parsed.scores === "object") {
      for (const [id, value] of Object.entries(parsed.scores as Record<string, unknown>)) {
        if (ctx.scores[id] && typeof value === "number") {
          ctx.scores[id].score = Math.max(0, Math.min(100, Math.round(value)));
        }
      }
    }

    // Store citations
    if (Array.isArray(parsed.sources)) {
      ctx.citations = parsed.sources as typeof ctx.citations;
    }

    // Override single overall score if provided
    if (typeof parsed.score === "number") {
      ctx.score = Math.max(0, Math.min(100, Math.round(parsed.score)));
    }
  } else {
    ctx.summaryText = text.slice(0, 2000);
    ctx.summaryRecommendations = [];
  }
}

async function runLLMGenerate(ctx: PipelineContext, config?: Record<string, unknown>): Promise<void> {
  const documentType = (config?.document_type as string) || "Analysis Report";
  const instructions = (config?.instructions as string) || "";

  // Build a compact prompt — the summary already incorporates reference/web/similar context
  const scoresText = Object.keys(ctx.scores).length > 0
    ? Object.entries(ctx.scores).map(([, s]) => `${s.label}: ${s.score}/100`).join(", ")
    : `Score: ${ctx.score}/${ctx.scoreMax}`;

  const rulesBrief = ctx.ruleResults
    .filter((r) => !r.passed)
    .map((r) => `- ${r.label} [${r.severity}]: ${r.message || "FAIL"}`)
    .join("\n");

  const citationNote = ctx.citations.length > 0
    ? `\n\nExisting sources from analysis: ${ctx.citations.map((c) => `[${c.id}] ${c.label}`).join("; ")}. You may reference these with [n] and add new sources as needed.`
    : "";

  const generateSystem = ctx.pipelinePrompts?.generate_system
    || `You generate professional ${documentType}s. Use markdown. Be thorough but concise.`;

  const citationInstructions = `\n\nIMPORTANT: Include inline source citations using [n] notation (e.g., [1], [2]) to reference specific data points from the input data. At the end of the document, include a "## Sources" section listing each cited data point with its origin table or record. This builds trust and allows verification.${citationNote}`;

  const { text } = await generateText({
    model: anthropic(ctx.model),
    maxOutputTokens: 4096,
    system: `${generateSystem}${citationInstructions}`,
    prompt: `Generate a ${documentType}.\n\n${scoresText}\n\nFailed checks:\n${rulesBrief || "None"}\n\n${ctx.summaryText ? `Analysis summary: ${ctx.summaryText}` : ""}\n\nRecommendations: ${ctx.summaryRecommendations.join("; ")}\n\n${instructions ? `Instructions: ${instructions}` : ""}\n\nKey data: ${JSON.stringify(ctx.extracted)}`,
    abortSignal: AbortSignal.timeout(STEP_TIMEOUT_MS),
  });

  ctx.generatedDocument = text;
}

async function runWebSearch(ctx: PipelineContext, config?: Record<string, unknown>): Promise<void> {
  const maxSearches = (config?.max_searches as number) || 3;
  const searchFocus = (config?.focus as string) || "";

  // Build compact context for query generation
  const keyFields = Object.entries(ctx.extracted).slice(0, 6).map(([k, v]) => `${k}: ${v}`).join(", ");
  const failedRules = ctx.ruleResults.filter((r) => !r.passed).map((r) => r.label).join(", ");

  // Step 1: Ask Claude to generate targeted search queries
  const { text: queryText } = await generateText({
    model: anthropic(ctx.model),
    maxOutputTokens: 512,
    system: `Generate ${maxSearches} web search queries as a JSON array. No markdown.${searchFocus ? ` Focus: ${searchFocus}` : ""}`,
    prompt: `Key data: ${keyFields}\nFlags: ${failedRules || "none"}\nContext: ${ctx.documentText.slice(0, 500)}`,
    abortSignal: AbortSignal.timeout(STEP_TIMEOUT_MS),
  });

  let queries: string[];
  try {
    const cleaned = queryText.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
    queries = JSON.parse(cleaned);
    if (!Array.isArray(queries)) queries = [String(queries)];
  } catch {
    // Fallback: use the focus or first extracted values as a query
    queries = [searchFocus || ctx.documentText.slice(0, 200)];
  }

  // Step 2: Run web searches using Claude's built-in web search tool
  // Cap at 2 searches to keep total pipeline time reasonable
  for (const query of queries.slice(0, Math.min(maxSearches, 2))) {
    try {
      const result = await generateText({
        model: anthropic(ctx.model),
        tools: {
          web_search: anthropic.tools.webSearch_20250305({ maxUses: 1 }),
        },
        system: `You are a research assistant. Search the web for the given query and provide a concise summary of the most relevant findings. Focus on current, factual information.`,
        prompt: query,
        abortSignal: AbortSignal.timeout(WEB_SEARCH_TIMEOUT_MS),
      });

      // Collect results from sources returned by web search
      if (result.sources && Array.isArray(result.sources)) {
        for (const source of result.sources) {
          if (source.sourceType === "url") {
            ctx.webSearchResults.push({
              query,
              title: ("title" in source && typeof source.title === "string" ? source.title : "") || query,
              url: source.url,
              snippet: result.text.slice(0, 300),
            });
          }
        }
      }

      // If no structured sources, store the text response as a result
      if (ctx.webSearchResults.filter((r) => r.query === query).length === 0 && result.text) {
        ctx.webSearchResults.push({
          query,
          title: query,
          url: "",
          snippet: result.text.slice(0, 500),
        });
      }
    } catch (e) {
      console.error(`Web search failed for "${query}":`, e);
    }
  }
}

async function runVectorSearch(ctx: PipelineContext, config?: Record<string, unknown>): Promise<void> {
  const table = config?.table as string;
  const topK = (config?.top_k as number) || 5;
  if (!table) {
    console.error("vector_search: no table configured");
    return;
  }

  // Build a text representation of extracted data for embedding
  const textParts = Object.entries(ctx.extracted)
    .filter(([, v]) => v !== null && v !== undefined)
    .map(([k, v]) => `${k}: ${v}`);
  if (textParts.length === 0 && ctx.documentText) {
    textParts.push(ctx.documentText.slice(0, 1000));
  }
  const queryText = textParts.join("; ");

  const voyageKey = process.env.VOYAGE_API_KEY;
  if (!voyageKey) {
    console.error("vector_search: VOYAGE_API_KEY not set");
    return;
  }

  try {
    // Generate embedding for the query
    const embResponse = await fetch("https://api.voyageai.com/v1/embeddings", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${voyageKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ input: [queryText], model: "voyage-3-lite" }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!embResponse.ok) throw new Error(`Voyage API error: ${embResponse.status}`);
    const embData = await embResponse.json();
    const embedding: number[] = embData.data[0].embedding;
    const embStr = `[${embedding.join(",")}]`;

    // Query pgvector for similar records
    const dbUrl = process.env.DATABASE_URL;
    if (!dbUrl) {
      // Fallback: use Supabase RPC if no direct DB access
      console.error("vector_search: DATABASE_URL not set, skipping");
      return;
    }

    // Use Supabase client with raw SQL via RPC, or direct pg query
    // We'll create a temporary RPC function approach using the supabase client
    const { createClient } = await import("@supabase/supabase-js");
    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SECRET_KEY!
    );

    // Use Supabase's rpc to call a similarity search
    // First try to create the function if it doesn't exist
    const { data, error } = await supabase.rpc("match_records", {
      query_embedding: embStr,
      match_table: table,
      match_count: topK,
    });

    if (error) {
      // Function might not exist yet — create it and retry
      if (error.code === "PGRST202" || error.message?.includes("Could not find")) {
        console.log("vector_search: creating match_records function...");
        // We can't create functions via Supabase client, use direct SQL
        // For now, fall back to fetching all and doing client-side similarity
        const { data: allRows } = await supabase
          .from(table)
          .select("*")
          .not("embedding", "is", null)
          .limit(50);

        if (allRows && allRows.length > 0) {
          // Client-side cosine similarity
          const scored = allRows.map((row) => {
            const rowEmb = row.embedding as number[] | null;
            if (!rowEmb || !Array.isArray(rowEmb)) return { row, score: 0 };
            let dot = 0, normA = 0, normB = 0;
            for (let i = 0; i < Math.min(embedding.length, rowEmb.length); i++) {
              dot += embedding[i] * rowEmb[i];
              normA += embedding[i] * embedding[i];
              normB += rowEmb[i] * rowEmb[i];
            }
            const score = normA && normB ? dot / (Math.sqrt(normA) * Math.sqrt(normB)) : 0;
            return { row, score };
          });
          scored.sort((a, b) => b.score - a.score);
          ctx.similarRecords = scored.slice(0, topK).map((s) => {
            const { embedding: _, ...rest } = s.row;
            return { ...rest, _similarity: Math.round(s.score * 1000) / 1000 };
          });
        }
      } else {
        console.error("vector_search rpc error:", error);
      }
    } else if (data) {
      ctx.similarRecords = data.map((r: Record<string, unknown>) => {
        const { embedding: _, ...rest } = r;
        return rest;
      });
    }

    if (ctx.similarRecords.length > 0) {
      console.log(`vector_search: found ${ctx.similarRecords.length} similar records in ${table}`);
    }
  } catch (e) {
    console.error("vector_search error:", e);
  }
}

function formatSimilarRecords(records: Array<Record<string, unknown>>): string {
  if (records.length === 0) return "";
  const items = records.slice(0, 3).map((r, i) => {
    const fields = Object.entries(r)
      .filter(([k]) => !k.startsWith("_") && k !== "id" && k !== "created_at" && k !== "embedding")
      .slice(0, 8)
      .map(([k, v]) => `${k}: ${v}`)
      .join(", ");
    return `${i + 1}. ${fields}`;
  }).join("\n");
  return `\n\nSimilar records:\n${items}`;
}

// ---------------------------------------------------------------------------
// Record Match: evaluate extracted data against each similar record's criteria
// ---------------------------------------------------------------------------

async function runRecordMatch(ctx: PipelineContext, config?: Record<string, unknown>): Promise<void> {
  if (ctx.similarRecords.length === 0) {
    console.log("record_match: no similar records to match against, skipping");
    return;
  }

  const matchInstructions = (config?.match_instructions as string) || "Compare the input data against each record's criteria";
  const criteriaFields = (config?.criteria_fields as string[]) || [];
  const labelField = (config?.label_field as string) || "title";

  // Build compact record summaries for matching
  const records = ctx.similarRecords.slice(0, 5).map((r, i) => {
    const id = (r.id as string) || `record_${i + 1}`;
    const label = (r[labelField] as string) || `Record #${i + 1}`;
    const fields = Object.entries(r)
      .filter(([k]) => !k.startsWith("_") && k !== "id" && k !== "created_at" && k !== "embedding")
      .map(([k, v]) => `${k}: ${v}`)
      .join(", ");
    return { id, label, fields };
  });

  const recordsText = records.map((r, i) =>
    `Record ${i + 1} (id: ${r.id}, label: ${r.label}):\n${r.fields}`
  ).join("\n\n");

  const criteriaHint = criteriaFields.length > 0
    ? `\nKey criteria fields to focus on: ${criteriaFields.join(", ")}`
    : "";

  const { text } = await generateText({
    model: anthropic(ctx.model),
    maxOutputTokens: 2048,
    system: `You match input data against records. Return ONLY a JSON array. No markdown.`,
    abortSignal: AbortSignal.timeout(STEP_TIMEOUT_MS),
    prompt: `${matchInstructions}${criteriaHint}

Input data:
${JSON.stringify(ctx.extracted)}

Records to match against:
${recordsText}

For each record, return:
[{"record_id": "id", "record_label": "label", "match_score": 0-100, "criteria_met": ["criterion 1"], "criteria_unmet": ["criterion 2"], "criteria_unclear": ["criterion needing confirmation"]}]

Score 100 = perfect match, 0 = no match. Be specific about which criteria from each record are met/unmet/unclear based on the input data.`,
  });

  try {
    const cleaned = text.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
    const matches = JSON.parse(cleaned);
    if (Array.isArray(matches)) {
      ctx.recordMatches = matches.sort((a, b) => b.match_score - a.match_score);
      console.log(`record_match: evaluated ${ctx.recordMatches.length} records`);
    }
  } catch (e) {
    console.error("record_match: failed to parse LLM response:", (e as Error).message);
  }
}

// ---------------------------------------------------------------------------
// LLM Custom: generic configurable LLM step
// ---------------------------------------------------------------------------

async function runLLMCustom(ctx: PipelineContext, config?: Record<string, unknown>): Promise<void> {
  const systemPrompt = (config?.system_prompt as string) || "You are a helpful assistant.";
  const promptTemplate = (config?.prompt_template as string) || "Analyze the following data:\n{{extracted}}";
  const outputField = (config?.output_field as string) || "custom_result";
  const maxTokens = (config?.max_tokens as number) || 2048;

  // Template substitution — inject pipeline context into the prompt
  const prompt = promptTemplate
    .replace(/\{\{extracted\}\}/g, JSON.stringify(ctx.extracted))
    .replace(/\{\{summary\}\}/g, ctx.summaryText)
    .replace(/\{\{recommendations\}\}/g, ctx.summaryRecommendations.join("; "))
    .replace(/\{\{score\}\}/g, String(ctx.score))
    .replace(/\{\{scores\}\}/g, JSON.stringify(ctx.scores))
    .replace(/\{\{document\}\}/g, ctx.documentText.slice(0, 2000))
    .replace(/\{\{rule_results\}\}/g, ctx.ruleResults.map((r) => `${r.label}: ${r.passed ? "PASS" : "FAIL"}`).join("\n"));

  const { text } = await generateText({
    model: anthropic(ctx.model),
    maxOutputTokens: maxTokens,
    system: systemPrompt,
    prompt,
    abortSignal: AbortSignal.timeout(STEP_TIMEOUT_MS),
  });

  ctx.customOutputs[outputField] = text;
}

function formatRecordMatches(matches: PipelineContext["recordMatches"]): string {
  if (matches.length === 0) return "";
  const items = matches.slice(0, 3).map((m) =>
    `- ${m.record_label} (${m.match_score}%): met=[${m.criteria_met.join(", ")}], unmet=[${m.criteria_unmet.join(", ")}], unclear=[${m.criteria_unclear.join(", ")}]`
  ).join("\n");
  return `\n\nRecord match results:\n${items}`;
}

// ---------------------------------------------------------------------------
// Build output sections
// ---------------------------------------------------------------------------

function buildSections(ctx: PipelineContext): OutputSection[] {
  const defs = ctx.outputSections?.sections;

  if (!defs || defs.length === 0) {
    const sections: OutputSection[] = [];

    if (Object.keys(ctx.extracted).length > 0) {
      sections.push({
        id: "extracted_fields",
        type: "field_table",
        title: "Extracted Fields",
        data: {
          fields: Object.entries(ctx.extracted).map(([name, value]) => ({
            name,
            label: name.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
            value,
          })),
        } satisfies FieldTableData,
      });
    }

    if (ctx.ruleResults.length > 0) {
      sections.push({
        id: "validation",
        type: "checklist",
        title: "Validation Results",
        data: { items: ctx.ruleResults } satisfies ChecklistData,
      });
    }

    if (ctx.ruleResults.length > 0) {
      // Named scores (multi-score pipelines)
      if (Object.keys(ctx.scores).length > 0) {
        for (const [id, s] of Object.entries(ctx.scores)) {
          sections.push({
            id: `score_${id}`,
            type: "score",
            title: s.label,
            data: { score: s.score, max: s.max } satisfies ScoreData,
          });
        }
      } else {
        // Single default score
        sections.push({
          id: "score",
          type: "score",
          title: "Overall Score",
          data: { score: ctx.score, max: ctx.scoreMax } satisfies ScoreData,
        });
      }
    }

    if (ctx.summaryText) {
      sections.push({
        id: "summary",
        type: "text",
        title: "Summary",
        data: { content: ctx.summaryText } satisfies TextData,
      });
    }

    if (ctx.citations.length > 0) {
      sections.push({
        id: "sources",
        type: "list",
        title: "Sources",
        data: {
          items: ctx.citations.map((c) => `**[${c.id}]** ${c.label}${c.detail ? ` — ${c.detail}` : ""}`),
        } satisfies ListData,
      });
    }

    if (ctx.summaryRecommendations.length > 0) {
      sections.push({
        id: "recommendations",
        type: "list",
        title: "Recommendations",
        data: { items: ctx.summaryRecommendations } satisfies ListData,
      });
    }

    if (ctx.similarRecords.length > 0) {
      sections.push({
        id: "similar_records",
        type: "field_table",
        title: "Comparable Past Records",
        data: {
          fields: ctx.similarRecords.flatMap((record, i) =>
            Object.entries(record)
              .filter(([k]) => k !== "id" && k !== "created_at" && !k.startsWith("_"))
              .map(([k, v]) => ({
                name: `record_${i + 1}_${k}`,
                label: `#${i + 1} ${k.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())}`,
                value: v,
              }))
          ),
        } satisfies FieldTableData,
      });
    }

    if (ctx.webSearchResults.length > 0) {
      sections.push({
        id: "web_research",
        type: "list",
        title: "Research Findings",
        data: {
          items: ctx.webSearchResults.map((r) =>
            `${r.title}${r.url ? ` — ${r.url}` : ""}: ${r.snippet}`
          ),
        } satisfies ListData,
      });
    }

    if (ctx.recordMatches.length > 0) {
      sections.push({
        id: "record_matches",
        type: "record_match" as OutputSection["type"],
        title: "Record Matches",
        data: { matches: ctx.recordMatches },
      });
    }

    // Custom LLM outputs — each gets its own document section
    for (const [field, content] of Object.entries(ctx.customOutputs)) {
      sections.push({
        id: `custom_${field}`,
        type: "document",
        title: field.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
        data: { content, format: "markdown" } satisfies DocumentData,
      });
    }

    if (ctx.generatedDocument) {
      sections.push({
        id: "generated_document",
        type: "document",
        title: "Generated Report",
        data: { content: ctx.generatedDocument, format: "markdown" } satisfies DocumentData,
      });
    }

    return sections;
  }

  return defs.map((def) => {
    switch (def.type) {
      case "field_table":
        return {
          ...def,
          data: {
            fields: Object.entries(ctx.extracted).map(([name, value]) => ({
              name,
              label: name.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
              value,
            })),
          } satisfies FieldTableData,
        };
      case "checklist":
        return { ...def, data: { items: ctx.ruleResults } satisfies ChecklistData };
      case "score": {
        // Check if this references a named score (e.g. source: "score.fraud")
        const scoreParts = def.source.split(".");
        const namedScore = scoreParts.length > 1 ? ctx.scores[scoreParts[1]] : null;
        if (namedScore) {
          return { ...def, data: { score: namedScore.score, max: namedScore.max } satisfies ScoreData };
        }
        return { ...def, data: { score: ctx.score, max: ctx.scoreMax } satisfies ScoreData };
      }
      case "text":
        return { ...def, data: { content: ctx.summaryText } satisfies TextData };
      case "list":
        return { ...def, data: { items: ctx.summaryRecommendations } satisfies ListData };
      case "kv_pairs":
        return {
          ...def,
          data: {
            pairs: Object.fromEntries(
              Object.entries(ctx.extracted).map(([k, v]) => [k, String(v)])
            ),
          } satisfies KVPairsData,
        };
      case "document":
        return {
          ...def,
          data: { content: ctx.generatedDocument, format: "markdown" } satisfies DocumentData,
        };
      case "web_search_results": {
        // If source is "similar", render similar records; otherwise web search results
        if (def.source === "similar" && ctx.similarRecords.length > 0) {
          return {
            ...def,
            data: {
              items: ctx.similarRecords.map((record, i) => {
                const fields = Object.entries(record)
                  .filter(([k]) => k !== "id" && k !== "created_at" && !k.startsWith("_") && k !== "embedding")
                  .map(([k, v]) => `${k.replace(/_/g, " ")}: ${v}`)
                  .join(", ");
                return `Record #${i + 1}: ${fields}`;
              }),
            } satisfies ListData,
          };
        }
        return {
          ...def,
          data: {
            items: ctx.webSearchResults.map((r) =>
              `${r.title}${r.url ? ` — ${r.url}` : ""}: ${r.snippet}`
            ),
          } satisfies ListData,
        };
      }
      case "record_match":
        return {
          ...def,
          data: { matches: ctx.recordMatches } as import("@/lib/types").RecordMatchData,
        };
      default:
        return { ...def, data: {} };
    }
  });
}

// ---------------------------------------------------------------------------
// Main: runPipeline
// ---------------------------------------------------------------------------

export async function runPipeline(opts: {
  documentText: string;
  systemPrompt: string;
  model: string;
  extractionSchema: ExtractionSchema | null;
  validationRules: ValidationRulesConfig | null;
  outputSections: OutputSectionsConfig | null;
  pipelineConfig: PipelineConfig | null;
  pipelinePrompts?: PipelinePrompts | null;
  referenceData?: Record<string, unknown[]>;
  preExtracted?: Record<string, unknown>;
}): Promise<{ sections: OutputSection[]; metadata: { pipeline_steps: string[]; duration_ms: number } }> {
  const start = Date.now();

  const ctx: PipelineContext = {
    ...opts,
    pipelinePrompts: opts.pipelinePrompts || null,
    referenceData: opts.referenceData || {},
    extracted: opts.preExtracted || {},
    ruleResults: [],
    score: 100,
    scoreMax: 100,
    scores: {},
    summaryText: "",
    summaryRecommendations: [],
    generatedDocument: "",
    customOutputs: {},
    webSearchResults: [],
    similarRecords: [],
    citations: [],
    recordMatches: [],
  };

  const steps = opts.pipelineConfig?.steps ?? [
    { id: "extract", type: "llm_extract" as const },
    { id: "validate", type: "rule_engine" as const },
    { id: "score", type: "compute_score" as const },
    { id: "summarize", type: "llm_summarize" as const },
  ];

  const executedSteps: string[] = [];

  for (const step of steps) {
    try {
      switch (step.type) {
        case "llm_extract":
          await runLLMExtract(ctx);
          break;
        case "rule_engine":
          runRuleEngine(ctx);
          break;
        case "compute_score":
          computeScore(ctx, step.config as Record<string, unknown> | undefined);
          break;
        case "llm_summarize":
          await runLLMSummarize(ctx);
          break;
        case "llm_generate":
          await runLLMGenerate(ctx, step.config as Record<string, unknown> | undefined);
          break;
        case "web_search":
          await runWebSearch(ctx, step.config as Record<string, unknown> | undefined);
          break;
        case "vector_search":
          await runVectorSearch(ctx, step.config as Record<string, unknown> | undefined);
          break;
        case "record_match":
          await runRecordMatch(ctx, step.config as Record<string, unknown> | undefined);
          break;
        case "llm_custom":
          await runLLMCustom(ctx, step.config as Record<string, unknown> | undefined);
          break;
      }
      executedSteps.push(step.id);
    } catch (err) {
      // Never abort — always continue so partial results are returned
      console.error(`Pipeline step ${step.id} (${step.type}) failed:`, (err as Error).message);
      executedSteps.push(`${step.id}:failed`);
    }
  }

  return {
    sections: buildSections(ctx),
    metadata: { pipeline_steps: executedSteps, duration_ms: Date.now() - start },
  };
}
