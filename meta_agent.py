"""Meta-agent: takes a scenario, assembles composable layout + configs, seeds Supabase.

Usage:
    uv run python meta_agent.py "Claims processing for a health insurer"
"""

import json
import os
import sys
from typing import Annotated

import anthropic
import httpx
import psycopg2
from dotenv import load_dotenv
from langgraph.types import Send
from langgraph.graph import END, START, StateGraph
from supabase import create_client
from typing_extensions import TypedDict

# Load env from interview-app/.env
load_dotenv(os.path.join(os.path.dirname(__file__), "interview-app", ".env"))

supabase = create_client(os.environ["SUPABASE_URL"], os.environ["SUPABASE_SECRET_KEY"])
claude = anthropic.Anthropic(api_key=os.environ["ANTHROPIC_API_KEY"])
DB_URL = os.environ["DATABASE_URL"]


def run_sql(sql: str) -> None:
    """Execute raw SQL against the Supabase Postgres database."""
    conn = psycopg2.connect(DB_URL)
    conn.autocommit = True
    with conn.cursor() as cur:
        cur.execute(sql)
    conn.close()


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def ask_claude(system: str, prompt: str, max_tokens: int = 4096) -> str:
    """Call Claude and return the text response."""
    resp = claude.messages.create(
        model="claude-sonnet-4-20250514",
        max_tokens=max_tokens,
        system=system,
        messages=[{"role": "user", "content": prompt}],
    )
    return resp.content[0].text


def parse_json(text: str, retries: int = 2) -> dict:
    """Extract JSON from Claude's response, stripping markdown fences if present.
    If parsing fails, asks Claude to fix the JSON before giving up."""
    cleaned = text.strip()
    if cleaned.startswith("```"):
        cleaned = cleaned.split("\n", 1)[1] if "\n" in cleaned else cleaned[3:]
        if cleaned.endswith("```"):
            cleaned = cleaned[:-3]
    try:
        return json.loads(cleaned.strip())
    except json.JSONDecodeError as e:
        if retries <= 0:
            raise
        print(f"  JSON parse error: {e} — asking Claude to fix...")
        fixed = ask_claude(
            "You are a JSON repair tool. Fix the broken JSON and return ONLY valid JSON, nothing else.",
            f"This JSON has a syntax error at {e}. Fix it:\n\n{cleaned[:12000]}",
            max_tokens=8192,
        )
        return parse_json(fixed, retries=retries - 1)


def merge_results(existing: list, new: list) -> list:
    """Reducer for accumulating parallel agent results."""
    return existing + new


VOYAGE_API_KEY = os.environ.get("VOYAGE_API_KEY", "")


def voyage_embed(texts: list[str], model: str = "voyage-3-lite") -> list[list[float]]:
    """Generate embeddings using Voyage AI. Returns list of 512-dim vectors."""
    if not VOYAGE_API_KEY or not texts:
        return []
    resp = httpx.post(
        "https://api.voyageai.com/v1/embeddings",
        headers={"Authorization": f"Bearer {VOYAGE_API_KEY}", "Content-Type": "application/json"},
        json={"input": texts, "model": model},
        timeout=30,
    )
    resp.raise_for_status()
    data = resp.json()["data"]
    return [item["embedding"] for item in sorted(data, key=lambda x: x["index"])]


def row_to_text(row: dict, skip: tuple = ("id", "created_at", "embedding", "stage")) -> str:
    """Convert a row dict to a searchable text string for embedding."""
    parts = []
    for k, v in row.items():
        if k in skip or v is None:
            continue
        parts.append(f"{k}: {v}")
    return "; ".join(parts)


# ---------------------------------------------------------------------------
# DB Migration (idempotent)
# ---------------------------------------------------------------------------

def ensure_columns():
    """Add new columns to config tables if they don't exist yet."""
    migrations = [
        'ALTER TABLE agent_config ADD COLUMN IF NOT EXISTS pipeline_config jsonb DEFAULT \'{}\'::jsonb;',
        'ALTER TABLE agent_config ADD COLUMN IF NOT EXISTS workflow_config jsonb DEFAULT \'{}\'::jsonb;',
        'ALTER TABLE agent_config ADD COLUMN IF NOT EXISTS extraction_schema jsonb DEFAULT \'{}\'::jsonb;',
        'ALTER TABLE agent_config ADD COLUMN IF NOT EXISTS validation_rules jsonb DEFAULT \'{}\'::jsonb;',
        'ALTER TABLE agent_config ADD COLUMN IF NOT EXISTS output_sections jsonb DEFAULT \'{}\'::jsonb;',
        'ALTER TABLE agent_config ADD COLUMN IF NOT EXISTS pipeline_prompts jsonb DEFAULT \'{}\'::jsonb;',
        "ALTER TABLE agent_config ADD COLUMN IF NOT EXISTS action_label text DEFAULT 'Generate Analysis';",
        'ALTER TABLE app_config ADD COLUMN IF NOT EXISTS form_config jsonb DEFAULT \'{}\'::jsonb;',
        'ALTER TABLE app_config ADD COLUMN IF NOT EXISTS layout jsonb DEFAULT \'[]\'::jsonb;',
        'ALTER TABLE app_config ALTER COLUMN template_id DROP NOT NULL;',
    ]
    for sql in migrations:
        try:
            run_sql(sql)
        except Exception:
            pass  # column already exists or similar


# ---------------------------------------------------------------------------
# State
# ---------------------------------------------------------------------------

class PlanState(TypedDict):
    scenario: str
    plan: dict
    results: Annotated[list[str], merge_results]
    datasources: list[dict]  # optional, from --from-datasources


# ---------------------------------------------------------------------------
# Node: Classifier
# ---------------------------------------------------------------------------

CLASSIFIER_SYSTEM = """You are a solution architect building composable AI applications. Given a user scenario, decide which UI components to include and generate full configuration for each.

Available layout components (pick the ones that fit):
- "form" — structured data entry (registration, applications, intake forms)
- "document_upload" — upload/paste documents for AI-powered analysis pipeline
- "workflow" — stateful items with stage transitions and user actions (approve, reject, escalate)
- "dashboard" — KPIs, charts, data tables for monitoring and analytics
- "research" — search bar + AI-generated report with sources (investigation, due diligence, market research)
- "chat_sidebar" — AI chat assistant available alongside other panels

Component selection guide:
- Analysis-heavy (compliance, review, auditing): ["document_upload", "chat_sidebar"] + pipeline + validation_rules
- Process-heavy (claims, onboarding, approvals): ["form", "workflow", "dashboard", "chat_sidebar"] + workflow_config
- Monitoring (risk, ops, analytics): ["dashboard", "chat_sidebar"] + KPIs + charts
- Data collection (registration, intake): ["form", "dashboard"] + form_config
- Research/investigation (due diligence, market research, regulatory): ["research", "dashboard", "chat_sidebar"]
- Advisory/Q&A (support bot, advisor chatbot): ["chat_sidebar"] only
- Mixed (loan origination, full process): ["form", "document_upload", "workflow", "dashboard", "chat_sidebar"]

Return ONLY valid JSON with this structure:
{
  "layout": ["form", "document_upload", "workflow", "dashboard", "chat_sidebar"],
  "title": "App Title",
  "description": "One-line description",
  "persona": "Who the AI assistant is (e.g. 'Senior Claims Adjuster')",

  "domain_tables": [
    {
      "name": "table_name_snake_case",
      "description": "what this table holds",
      "columns": {"col_name": "type (text/integer/numeric/boolean/timestamptz)", ...},
      "sample_rows": 10
    }
  ],

  "form_config": {
    "title": "Form Title",
    "sections": [
      {
        "label": "Section Name",
        "fields": [
          {"name": "field_name", "label": "Display Label", "type": "text|number|date|select|checkbox|textarea|email|phone", "required": true, "options": ["only for select type"]}
        ]
      }
    ],
    "target_table": "table_name",
    "post_submit_pipeline": true
  },

  "extraction_schema": {
    "fields": [
      {"name": "field_name", "type": "string|number|boolean|enum|date", "description": "What to extract", "required": true, "options": ["only for enum"]}
    ]
  },

  "validation_rules": {
    "rules": [
      {
        "id": "rule_id",
        "label": "Human-readable rule name",
        "expression": "field_name OR math expression (e.g. debt_amount / borrower_income). Supports AND/OR: 'lives_alone AND age' evaluates both sides against operator/threshold.",
        "operator": "eq|neq|gt|gte|lt|lte|is_true|is_false|in",
        "threshold": "number, string, or comma-separated for 'in' (e.g. 'emergent,urgent'). Ignored for is_true/is_false.",
        "severity": "critical|warning|info",
        "fail_message": "Message when rule fails. Use {{value}} for computed value",
        "category": "optional — e.g. 'fraud', 'complexity', 'compliance', 'clinical'. Used to group rules for multi-score pipelines."
      }
    ]
  },

  "pipeline_config": {
    "steps": [
      {"id": "extract", "type": "llm_extract"},
      {"id": "validate", "type": "rule_engine"},
      {"id": "score", "type": "compute_score", "config": {"weights": {"critical": 3, "warning": 1, "info": 0}}},  // single overall score — OR use multiple named scores (see NOTE below)

      {"id": "summarize", "type": "llm_summarize"},
      {"id": "generate", "type": "llm_generate", "config": {"document_type": "Analysis Report", "instructions": "Include all findings and recommendations"}},
      {"id": "research", "type": "web_search", "config": {"max_searches": 3, "focus": "Describe what to search for based on extracted data"}},
      {"id": "similar", "type": "vector_search", "config": {"table": "table_to_search", "top_k": 5}},
      {"id": "match", "type": "record_match", "config": {"match_instructions": "Compare input against each record's criteria", "criteria_fields": ["key_inclusion", "key_exclusion"], "label_field": "title"}},
      {"id": "patient_letter", "type": "llm_custom", "config": {"system_prompt": "You write empathetic patient-friendly letters.", "prompt_template": "Write a letter explaining the results to the patient.\n\nData: {{extracted}}\nScore: {{score}}\nSummary: {{summary}}", "output_field": "patient_letter", "max_tokens": 2048}}
    ]
  },

  NOTE: The "llm_generate" step is OPTIONAL. Include it when the scenario needs to produce formal documents (SAR reports, approval letters, discharge summaries, audit reports, etc.). Omit it for simple analysis or monitoring scenarios.
  NOTE: The "web_search" step is OPTIONAL. Include it when the scenario benefits from real-time external information (market news, regulatory updates, recent research, current events). Place it AFTER extraction but BEFORE summarize/generate so those steps can use the search results. Config: {"max_searches": 2-4, "focus": "what to search for"}.
  NOTE: The "vector_search" step is OPTIONAL. Include it when the scenario benefits from finding comparable past records (prior loan decisions, similar patient cases, historical claims). It uses vector similarity to find the most relevant records. Place it AFTER extraction but BEFORE summarize/generate. Config: {"table": "table_name_to_search", "top_k": 3-5}. The table MUST be one of the domain_tables.
  NOTE: MULTI-SCORE PIPELINES — When the scenario has multiple distinct risk/assessment dimensions (e.g. fraud risk + complexity score, clinical severity + social risk, credit risk + compliance score), use MULTIPLE compute_score steps with category filters instead of a single overall score. Tag each validation rule with a "category" field matching the dimension it belongs to. Then add one compute_score step per dimension:
    {"id": "fraud_score", "type": "compute_score", "config": {"category": "fraud", "score_id": "fraud", "label": "Fraud Risk Score", "weights": {"critical": 3, "warning": 1, "info": 0}}},
    {"id": "complexity_score", "type": "compute_score", "config": {"category": "complexity", "score_id": "complexity", "label": "Complexity Score", "weights": {"critical": 3, "warning": 1, "info": 0}}}
  And add corresponding output sections with source "score.fraud" and "score.complexity".
  Use SINGLE score (no category) for scenarios with one risk dimension. Use MULTI-score for 2+ distinct dimensions.
  NOTE: The "record_match" step is OPTIONAL. Include it AFTER "vector_search" when the scenario requires evaluating the input against each retrieved record's individual criteria — not just finding similar records, but assessing fit/eligibility/match per record. Examples: patient vs. clinical trial eligibility, borrower vs. lending products, candidate vs. job requirements, claim vs. policy coverages. Config: {"match_instructions": "what to compare", "criteria_fields": ["fields in the record that contain criteria"], "label_field": "field to use as record label"}. Omit when vector_search alone is sufficient (finding comparable past cases for reference, not per-record evaluation).
  NOTE: The "llm_custom" step is a GENERIC LLM step for any additional AI output. Include it when you need to generate something beyond the standard summary/report — e.g. patient-friendly letters, executive briefings, email drafts, compliance narratives. Config: {"system_prompt": "role and tone", "prompt_template": "template with {{extracted}} {{summary}} {{score}} {{scores}} {{document}} {{rule_results}} {{recommendations}} placeholders", "output_field": "unique_name_for_output", "max_tokens": 2048}. Each llm_custom step produces a separate document section. Place it AFTER summarize (so {{summary}} is available).

  "output_sections": {
    "sections": [
      {"id": "extracted_fields", "type": "field_table", "title": "Extracted Fields", "source": "extraction"},
      {"id": "compliance_check", "type": "checklist", "title": "Compliance Checklist", "source": "validation"},
      {"id": "risk_score", "type": "score", "title": "Risk Score", "source": "score"},  // OR use "source": "score.fraud" for named multi-scores

      {"id": "web_research", "type": "web_search_results", "title": "Research Findings", "source": "web_search"},
      {"id": "matches", "type": "record_match", "title": "Matched Records", "source": "record_match"},
      {"id": "summary", "type": "text", "title": "Summary", "source": "summary"},
      {"id": "recommendations", "type": "list", "title": "Recommendations", "source": "summary.recommendations"},
      {"id": "generated_report", "type": "document", "title": "Generated Report", "source": "document"}
    ]
  },

  NOTE: Only include "document" type output section if the pipeline has an "llm_generate" step.
  NOTE: Only include "web_search_results" type output section if the pipeline has a "web_search" step.
  NOTE: Only include "record_match" type output section if the pipeline has a "record_match" step.

  "workflow_config": {
    "stages": [
      {
        "id": "stage_id",
        "label": "Stage Name",
        "actions": [
          {"id": "action_id", "label": "Button Label", "next_stage": "next_stage_id", "style": "default|destructive", "confirm": false, "side_effect": {"type": "set_fields|webhook", "fields": {"priority": "high"}, "webhook_url": "https://..."}}  // side_effect is OPTIONAL
        ]
      },
      {"id": "terminal_stage_id", "label": "Terminal Stage", "actions": [], "terminal": true}
    ],
    "initial_stage": "first_stage_id",
    "item_table": "table_name"
  },

  "kpi_config": [
    {"label": "KPI Name", "table": "table_name", "aggregate": "count|sum|avg|count_ratio", "field": "col_name or null for count/count_ratio", "format": "number|currency|percent", "filter": "col.eq.value or col.in.(a,b) or col.gt.value or null"}
  ],
  "chart_config": [
    {"title": "Chart Title", "type": "bar|line|pie|area", "table": "table_name", "x_field": "col", "y_field": "col"}
  ],
  "table_display": {
    "source_table": "table_name",
    "columns": ["col1", "col2", "col3"]
  },
  "pipeline_prompts": {
    "extract_system": "optional — override the default extraction system prompt for domain-specific tone/instructions",
    "summarize_system": "optional — override the default summarize system prompt",
    "generate_system": "optional — override the default document generation system prompt"
  },

  "action_label": "Domain-specific label for the main action button, e.g. 'Generate Meeting Briefing', 'Assess Claim Risk', 'Review Authorization', 'Match to Trials', 'Screen Patient'",

  "user_context": {
    "name": "Name of the logged-in user (if the scenario describes a specific user persona, e.g. 'Maria Santos', 'Sarah Chen'). Omit this entire object for admin/back-office tools where no specific user is logged in.",
    "role": "Their role (e.g. 'Patient — Aetna PPO', 'Wealth Advisor, CFP', 'Senior Claims Adjuster')",
    "details": "Brief context about them (e.g. '52F, Type 2 Diabetes, Hypertension', 'Manages 180 households, $120M AUM')"
  },

  "quick_actions": [
    {"label": "Button text", "prompt": "What the AI should be asked"}
  ],
  "system_prompt": "Detailed system prompt for the AI assistant"
}

PIPELINE DESIGN PRINCIPLES:
- The pipeline should solve ONE problem well. Include ONLY the steps needed for the scenario.
- For ADVISORY/BRIEFING scenarios (meeting prep, portfolio review, patient summary): Use ONLY llm_extract → llm_summarize → llm_generate. Skip rules, scores, web search. The value IS the synthesized narrative.
- For ASSESSMENT/TRIAGE scenarios (claims, prior auth, loan underwriting, compliance): Use llm_extract → rule_engine → compute_score → llm_summarize → llm_generate. Rules and scores drive decisions.
- For MATCHING scenarios (clinical trials, product matching, SDOH programs): Use llm_extract → vector_search → record_match → llm_summarize. Matches are the value.
- For RESEARCH/INVESTIGATION scenarios (due diligence, market research, regulatory): Use llm_extract → web_search → llm_summarize → llm_generate. Fresh external info is the value. However, do consider looking through the internal vector database (hosted on Supabase).
- Every step costs time. Only include a step if it directly serves the user's core need. Don't pad the pipeline with "nice to haves."
- web_search is SLOW (20s+). Only include when real-time external info is essential (market data, regulatory updates, public records checks). Skip for internal data scenarios.
- vector_search + record_match are a pair: vector_search finds candidates, record_match evaluates fit. Only include when per-record eligibility/matching matters (trials, products, programs). Don't include for simple "find similar" — vector_search alone suffices.

CRITICAL RULES:
1. Only include config objects for components in the layout. No form_config if "form" not in layout. No workflow_config if "workflow" not in layout.
2. If "document_upload" or "form" with post_submit_pipeline is in layout, ALWAYS include extraction_schema + validation_rules + pipeline_config + output_sections with REAL domain-specific rules and thresholds.
3. validation_rules must use REAL industry thresholds (e.g. DTI <= 0.43 for mortgages, fridge temp <= 40°F for restaurants, hemoglobin 12-17 g/dL for labs).
4. extraction_schema fields must match what validation_rules reference. Every field used in a rule expression must exist in extraction_schema.
11. For BOOLEAN fields (e.g. oncology_service, is_sanctioned), use operator "is_true" or "is_false" with threshold: true/false.
    For STRING/ENUM fields (e.g. admission_type), use operator "eq" with a string threshold, or "in" with comma-separated values (e.g. "emergent,urgent").
    For COMPOUND conditions (e.g. lives alone AND age > 65), use "field_a AND field_b" as the expression — both sides are tested against the same operator/threshold. Split compound rules where the sub-conditions need DIFFERENT operators into separate rules.
5. If "workflow" is in layout, the workflow_config.item_table MUST be one of the domain_tables, and that table MUST have a "stage" column of type "text".
6. If "form" is in layout, form_config.target_table MUST be one of the domain_tables, and form field names must match table columns.
7. Domain tables should have 8-15 sample rows. For workflow tables, set the "stage" column values to distribute across workflow stages.
8. Generate 3-5 KPIs, 2-4 charts, and 2-4 quick actions when "dashboard" is in layout.
9. Make data realistic and domain-appropriate. Use real industry terminology.
10. KPI CORRECTNESS IS CRITICAL. Each KPI's "field" must be an ACTUAL column in the table that makes semantic sense for the metric:
    - For rate/percentage KPIs (approval rate, rejection rate): use "count_ratio" aggregate with a filter for the numerator. Example: {"label": "Approval Rate", "table": "loans", "aggregate": "count_ratio", "filter": "stage.eq.approved", "format": "percent"}
    - For averages: the "field" must be a numeric column that semantically matches (e.g. "days_to_decision" for avg processing time, NOT "loan_amount"). If the column doesn't exist in domain_tables, ADD IT to domain_tables with realistic values.
    - For counts with complex filters: use PostgREST filter syntax: col.eq.val, col.in.(a,b,c), col.gt.val, col.gte.val, col.lt.val, col.lte.val
    - NEVER use a monetary/amount field for a time-based KPI or vice versa. Double-check that each KPI's field matches its label."""


PLAN_DIR = os.path.join(os.path.dirname(__file__), "plans")


def broadcast_progress(message: str, step: int = 0, total: int = 5):
    """Send a progress update to the UI via Supabase realtime."""
    try:
        supabase.table("dashboard_updates").insert({
            "component_id": "generation_progress",
            "data": {"message": message, "step": step, "total": total},
        }).execute()
    except Exception:
        pass  # Don't let progress broadcasting break the pipeline
    print(f"  [{step}/{total}] {message}")


def _print_plan_summary(plan: dict) -> None:
    print(f"  Layout: {plan['layout']}")
    print(f"  Title: {plan['title']}")
    print(f"  Tables: {[t['name'] for t in plan.get('domain_tables', [])]}")
    if plan.get("form_config"):
        print(f"  Form: {plan['form_config']['title']} -> {plan['form_config']['target_table']}")
    if plan.get("workflow_config"):
        stages = [s["id"] for s in plan["workflow_config"]["stages"]]
        print(f"  Workflow stages: {stages}")
    if plan.get("validation_rules", {}).get("rules"):
        print(f"  Validation rules: {len(plan['validation_rules']['rules'])}")
    if plan.get("extraction_schema", {}).get("fields"):
        print(f"  Extraction fields: {len(plan['extraction_schema']['fields'])}")


def _save_plan(plan: dict, scenario: str) -> str:
    """Save the plan JSON and a human-readable summary to plans/."""
    os.makedirs(PLAN_DIR, exist_ok=True)
    slug = plan.get("title", scenario)[:60].lower()
    slug = "".join(c if c.isalnum() or c in "-_ " else "" for c in slug).strip().replace(" ", "_")

    # Save JSON (machine-readable, used by --from-plan)
    json_path = os.path.join(PLAN_DIR, f"{slug}.json")
    with open(json_path, "w") as f:
        json.dump(plan, f, indent=2)

    # Save human-readable summary
    readme_path = os.path.join(PLAN_DIR, f"{slug}.md")
    lines = [
        f"# {plan.get('title', 'Untitled')}",
        f"_{plan.get('description', '')}_",
        f"",
        f"**Persona:** {plan.get('persona', 'AI Assistant')}  ",
        f"**Action Label:** {plan.get('action_label', 'Generate Analysis')}  ",
        f"**Layout:** {', '.join(plan.get('layout', []))}",
        f"",
        f"---",
        f"",
        f"## Tables",
        f"",
    ]
    for t in plan.get("domain_tables", []):
        cols = {k: v for k, v in t.get("columns", {}).items() if k not in ("id", "created_at")}
        lines.append(f"### {t['name']} ({t.get('sample_rows', '?')} rows)")
        if t.get("description"):
            lines.append(f"_{t['description']}_")
        lines.append(f"")
        for col, typ in cols.items():
            lines.append(f"- `{col}` ({typ})")
        lines.append(f"")

    if plan.get("form_config"):
        fc = plan["form_config"]
        lines.append(f"## Form: {fc.get('title', '')}")
        lines.append(f"Target table: `{fc.get('target_table', '?')}`")
        lines.append(f"")
        for section in fc.get("sections", []):
            lines.append(f"### {section['label']}")
            for field in section.get("fields", []):
                req = " **(required)**" if field.get("required") else ""
                opts = f" — options: {', '.join(field['options'])}" if field.get("options") else ""
                lines.append(f"- {field['label']} (`{field['name']}`, {field['type']}){req}{opts}")
            lines.append(f"")

    if plan.get("pipeline_config", {}).get("steps"):
        lines.append(f"## Pipeline")
        lines.append(f"")
        for i, step in enumerate(plan["pipeline_config"]["steps"], 1):
            cfg = step.get("config", {})
            detail = ""
            if cfg.get("label"):
                detail = f" — {cfg['label']}"
            elif cfg.get("document_type"):
                detail = f" — generates: {cfg['document_type']}"
            elif cfg.get("table"):
                detail = f" — searches: `{cfg['table']}`"
            elif cfg.get("output_field"):
                detail = f" — output: {cfg['output_field']}"
            elif cfg.get("focus"):
                detail = f" — focus: {cfg['focus']}"
            lines.append(f"{i}. **{step['id']}** (`{step['type']}`){detail}")
        lines.append(f"")

    if plan.get("validation_rules", {}).get("rules"):
        lines.append(f"## Validation Rules")
        lines.append(f"")
        for rule in plan["validation_rules"]["rules"]:
            cat = f" [{rule['category']}]" if rule.get("category") else ""
            lines.append(f"- **{rule['label']}** ({rule['severity']}{cat}): `{rule['expression']}` {rule['operator']} `{rule['threshold']}`")
            if rule.get("fail_message"):
                lines.append(f"  > {rule['fail_message']}")
        lines.append(f"")

    if plan.get("kpi_config"):
        lines.append(f"## KPIs")
        lines.append(f"")
        for kpi in plan["kpi_config"]:
            filt = f", filter: `{kpi['filter']}`" if kpi.get("filter") else ""
            lines.append(f"- **{kpi['label']}**: {kpi['aggregate']}(`{kpi.get('field') or '*'}`) from `{kpi['table']}` ({kpi['format']}{filt})")
        lines.append(f"")

    if plan.get("output_sections", {}).get("sections"):
        lines.append(f"## Output Sections")
        lines.append(f"")
        for sec in plan["output_sections"]["sections"]:
            lines.append(f"- **{sec['title']}** (`{sec['type']}`) — source: `{sec['source']}`")
        lines.append(f"")

    if plan.get("quick_actions"):
        lines.append(f"## Quick Actions")
        lines.append(f"")
        for qa in plan["quick_actions"]:
            lines.append(f"- **{qa['label']}**: _{qa['prompt']}_")
        lines.append(f"")

    if plan.get("realtime_sources"):
        lines.append(f"## Realtime Data Sources")
        lines.append(f"")
        for src in plan["realtime_sources"]:
            lines.append(f"### {src.get('id', '?')} → `{src.get('target_table', '?')}`")
            lines.append(f"_{src.get('description', '')}_")
            lines.append(f"")
            urls = src.get("urls", [])
            if urls:
                lines.append(f"**URLs:** ({len(urls)} endpoint{'s' if len(urls) != 1 else ''})")
                for url in urls[:5]:
                    lines.append(f"- `{url}`")
                if len(urls) > 5:
                    lines.append(f"- _...and {len(urls) - 5} more_")
            lines.append(f"")

    lines.append(f"---")
    lines.append(f"_Edit the `.json` file and re-run:_")
    lines.append(f"```")
    lines.append(f"uv run python meta_agent.py --from-plan {json_path}")
    lines.append(f"```")

    with open(readme_path, "w") as f:
        f.write("\n".join(lines))

    print(f"\n  Plan saved to: {json_path}")
    print(f"  Summary:       {readme_path}")
    print(f"  Edit and re-run with: uv run python meta_agent.py --from-plan {json_path}")
    return json_path


def classify_scenario(state: PlanState) -> dict:
    # If plan was pre-loaded (--from-plan), skip classification
    if state.get("plan") and state["plan"].get("title"):
        broadcast_progress("Loading saved configuration...", 1, 5)
        _print_plan_summary(state["plan"])
        return {}

    broadcast_progress("Analyzing scenario and designing solution...", 1, 5)
    text = ask_claude(CLASSIFIER_SYSTEM, f"Scenario: {state['scenario']}", max_tokens=8192)
    plan = parse_json(text)

    _print_plan_summary(plan)
    _save_plan(plan, state["scenario"])

    return {"plan": plan}


# ---------------------------------------------------------------------------
# Fan-out router
# ---------------------------------------------------------------------------

def fan_out(state: PlanState) -> list[Send]:
    sends = [
        Send("seed_data", state),
        Send("write_app_config", state),
        Send("write_agent_config", state),
    ]
    # Only fetch images if Unsplash key is available
    if os.environ.get("UNSPLASH_ACCESS_KEY"):
        sends.append(Send("fetch_images", state))
    return sends


# ---------------------------------------------------------------------------
# Node: Fetch Images (parallel, optional)
# ---------------------------------------------------------------------------

def fetch_images(state: PlanState) -> dict:
    """Search Unsplash for relevant images and store URLs in app_config."""
    plan = state["plan"]
    access_key = os.environ.get("UNSPLASH_ACCESS_KEY", "")
    if not access_key:
        return {"results": ["images_skipped"]}

    title = plan.get("title", "")
    tables = [t["name"].replace("_", " ") for t in plan.get("domain_tables", [])]

    # Build search queries from the scenario
    queries = [title]
    # Add domain-specific terms
    for table in tables[:3]:
        queries.append(table)

    images: dict[str, str] = {}
    for i, query in enumerate(queries[:5]):
        try:
            resp = httpx.get(
                "https://api.unsplash.com/search/photos",
                params={"query": query, "per_page": 1, "orientation": "landscape"},
                headers={"Authorization": f"Client-ID {access_key}"},
                timeout=10,
            )
            if resp.status_code == 200:
                results = resp.json().get("results", [])
                if results:
                    raw_url = results[0]["urls"]["regular"]
                    # Crop to consistent size
                    images[f"image_{i}"] = raw_url + "&w=800&h=400&fit=crop"
                    photographer = results[0].get("user", {}).get("name", "")
                    if photographer:
                        images[f"image_{i}_credit"] = photographer
                    print(f"  Image {i+1}: found for '{query}'")
        except Exception as e:
            print(f"  Warning: Image search failed for '{query}': {e}")

    if images:
        # Update app_config with images
        try:
            result = supabase.table("app_config").select("id, layout_overrides").order("created_at", desc=True).limit(1).single().execute()
            if result.data:
                overrides = result.data.get("layout_overrides") or {}
                overrides["images"] = images
                supabase.table("app_config").update({"layout_overrides": overrides}).eq("id", result.data["id"]).execute()
                print(f"  Stored {len([k for k in images if not k.endswith('_credit')])} images in app_config")
        except Exception as e:
            print(f"  Warning: Could not store images: {e}")

    return {"results": ["images_fetched"]}


# ---------------------------------------------------------------------------
# Node: Seed Data
# ---------------------------------------------------------------------------

CORE_TABLES = frozenset({
    "app_config", "agent_config", "activity_log", "pipeline_results",
    "dashboard_updates", "schema_migrations",
})


def seed_data(state: PlanState) -> dict:
    broadcast_progress("Building database and generating data...", 2, 5)
    plan = state["plan"]
    tables = plan.get("domain_tables", [])

    # Drop stale domain tables from previous runs
    new_table_names = {t["name"] for t in tables}
    conn = psycopg2.connect(DB_URL)
    conn.autocommit = True
    with conn.cursor() as cur:
        cur.execute("""
            SELECT tablename FROM pg_tables
            WHERE schemaname = 'public'
        """)
        existing = {row[0] for row in cur.fetchall()}
    conn.close()

    stale = existing - CORE_TABLES - new_table_names
    for tbl in stale:
        try:
            run_sql(f'DROP TABLE IF EXISTS "{tbl}" CASCADE;')
            print(f"  Dropped stale table: {tbl}")
        except Exception:
            pass

    for table_def in tables:
        name = table_def["name"]
        columns = table_def["columns"]

        # Build CREATE TABLE SQL
        col_defs = []
        for col_name, col_type in columns.items():
            if col_name in ("id", "created_at", "notes"):
                continue
            pg_type = col_type.lower().strip()
            type_map = {
                "string": "text", "str": "text", "varchar": "text",
                "int": "integer", "long": "bigint", "biginteger": "bigint",
                "float": "numeric", "double": "numeric", "decimal": "numeric", "number": "numeric",
                "bool": "boolean",
                "datetime": "timestamptz", "timestamp": "timestamptz", "date_time": "timestamptz",
                "json": "jsonb", "object": "jsonb", "array": "jsonb",
                "uuid": "text",  # let PG handle uuid via default
            }
            pg_type = type_map.get(pg_type, pg_type)
            col_defs.append(f'"{col_name}" {pg_type}')

        create_sql = f"""
        DROP TABLE IF EXISTS "{name}" CASCADE;
        CREATE TABLE "{name}" (
            id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
            {', '.join(col_defs)},
            notes text,
            created_at timestamptz DEFAULT now()
        );
        """

        rls_sql = f"""
        ALTER TABLE "{name}" ENABLE ROW LEVEL SECURITY;
        DROP POLICY IF EXISTS "anon_read_{name}" ON "{name}";
        CREATE POLICY "anon_read_{name}" ON "{name}" FOR SELECT TO anon USING (true);
        DROP POLICY IF EXISTS "anon_insert_{name}" ON "{name}";
        CREATE POLICY "anon_insert_{name}" ON "{name}" FOR INSERT TO anon WITH CHECK (true);
        DROP POLICY IF EXISTS "anon_update_{name}" ON "{name}";
        CREATE POLICY "anon_update_{name}" ON "{name}" FOR UPDATE TO anon USING (true) WITH CHECK (true);
        """

        realtime_sql = f"""
        DO $$ BEGIN
            ALTER PUBLICATION supabase_realtime ADD TABLE "{name}";
        EXCEPTION WHEN duplicate_object THEN NULL;
        END $$;
        """

        run_sql(create_sql)
        run_sql(rls_sql)
        run_sql(realtime_sql)
        print(f"  Created table: {name}")

    # Ensure activity_log table exists (for workflow actions)
    run_sql("""
        CREATE TABLE IF NOT EXISTS activity_log (
            id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
            action text,
            item_id uuid,
            stage_from text,
            stage_to text,
            timestamp timestamptz DEFAULT now()
        );
        ALTER TABLE activity_log ENABLE ROW LEVEL SECURITY;
        DROP POLICY IF EXISTS "anon_read_activity_log" ON activity_log;
        CREATE POLICY "anon_read_activity_log" ON activity_log FOR SELECT TO anon USING (true);
        DROP POLICY IF EXISTS "anon_insert_activity_log" ON activity_log;
        CREATE POLICY "anon_insert_activity_log" ON activity_log FOR INSERT TO anon WITH CHECK (true);
    """)

    # Ensure pipeline_results table exists (stores analysis results linked to items)
    run_sql("""
        CREATE TABLE IF NOT EXISTS pipeline_results (
            id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
            item_id uuid,
            item_table text,
            sections jsonb DEFAULT '[]'::jsonb,
            score integer,
            metadata jsonb DEFAULT '{}'::jsonb,
            created_at timestamptz DEFAULT now()
        );
        ALTER TABLE pipeline_results ENABLE ROW LEVEL SECURITY;
        DROP POLICY IF EXISTS "anon_read_pipeline_results" ON pipeline_results;
        CREATE POLICY "anon_read_pipeline_results" ON pipeline_results FOR SELECT TO anon USING (true);
        DROP POLICY IF EXISTS "anon_insert_pipeline_results" ON pipeline_results;
        CREATE POLICY "anon_insert_pipeline_results" ON pipeline_results FOR INSERT TO anon WITH CHECK (true);
    """)

    # Add pipeline_results to realtime
    run_sql("""
        DO $$ BEGIN
            ALTER PUBLICATION supabase_realtime ADD TABLE pipeline_results;
        EXCEPTION WHEN duplicate_object THEN NULL;
        END $$;
    """)

    # Generate sample data
    if tables:
        # Include workflow stage hints if applicable
        workflow_config = plan.get("workflow_config", {})
        stage_hint = ""
        if workflow_config.get("stages") and workflow_config.get("item_table"):
            stage_names = [s["id"] for s in workflow_config["stages"]]
            stage_hint = f"\nFor table '{workflow_config['item_table']}', the 'stage' column must use values from: {stage_names}. Distribute rows across these stages realistically (more in early stages, fewer in terminal stages)."

        system = f"""You generate realistic sample data as JSON arrays.
Return ONLY valid JSON — an object where each key is a table name and the value is an array of row objects.
IMPORTANT: Do NOT include "id" or "created_at" fields — those are auto-generated by the database.
No markdown, no explanation. Just the JSON.{stage_hint}"""

        table_specs = []
        for t in tables:
            table_specs.append(
                f"Table '{t['name']}': columns {json.dumps(t['columns'])}. Generate {t.get('sample_rows', 10)} rows."
            )

        # Try bulk generation first (all tables at once, higher token limit)
        text = ask_claude(system, f"Domain: {plan['title']}\n\n" + "\n".join(table_specs), max_tokens=16384)
        all_data = parse_json(text)

        seeded_tables = set()
        for table_name, rows in all_data.items():
            if rows:
                try:
                    supabase.table(table_name).insert(rows).execute()
                    print(f"  Seeded {len(rows)} rows into: {table_name}")
                    seeded_tables.add(table_name)
                except Exception as e:
                    print(f"  Warning: Could not seed {table_name}: {e}")

        # Retry any tables that weren't seeded (JSON truncation, parse error, etc.)
        for t in tables:
            if t["name"] not in seeded_tables:
                print(f"  Retrying seed for: {t['name']}")
                try:
                    retry_text = ask_claude(
                        system,
                        f"Domain: {plan['title']}\n\nTable '{t['name']}': columns {json.dumps(t['columns'])}. Generate {t.get('sample_rows', 10)} rows.\n\nReturn: {{\"{t['name']}\": [...]}}",
                        max_tokens=4096,
                    )
                    retry_data = parse_json(retry_text)
                    rows = retry_data.get(t["name"], [])
                    if rows:
                        supabase.table(t["name"]).insert(rows).execute()
                        print(f"  Seeded {len(rows)} rows into: {t['name']} (retry)")
                        seeded_tables.add(t["name"])
                except Exception as e:
                    print(f"  Warning: Retry failed for {t['name']}: {e}")

    # Generate and store embeddings for seeded data
    if VOYAGE_API_KEY and tables:
        run_sql('CREATE EXTENSION IF NOT EXISTS vector;')
        for table_def in tables:
            name = table_def["name"]
            try:
                # Add embedding column
                run_sql(f'ALTER TABLE "{name}" ADD COLUMN IF NOT EXISTS embedding vector(512);')

                # Fetch rows
                result = supabase.table(name).select("*").execute()
                rows = result.data or []
                if not rows:
                    continue

                # Generate embeddings in batches of 20
                texts = [row_to_text(r) for r in rows]
                ids = [r["id"] for r in rows]
                batch_size = 20
                embedded = 0
                for i in range(0, len(texts), batch_size):
                    batch_texts = texts[i:i + batch_size]
                    batch_ids = ids[i:i + batch_size]
                    try:
                        embeddings = voyage_embed(batch_texts)
                        for row_id, emb in zip(batch_ids, embeddings):
                            emb_str = "[" + ",".join(str(x) for x in emb) + "]"
                            run_sql(f"""UPDATE "{name}" SET embedding = '{emb_str}'::vector WHERE id = '{row_id}';""")
                        embedded += len(embeddings)
                    except Exception as e:
                        print(f"  Warning: Embedding batch failed for {name}: {e}")
                        break

                # Create similarity search index
                run_sql(f"""
                    CREATE INDEX IF NOT EXISTS "{name}_embedding_idx"
                    ON "{name}" USING ivfflat (embedding vector_cosine_ops) WITH (lists = 1);
                """)

                if embedded > 0:
                    print(f"  Embedded {embedded} rows in: {name}")
            except Exception as e:
                print(f"  Warning: Could not embed {name}: {e}")

    return {"results": ["data_seeded"]}


# ---------------------------------------------------------------------------
# Node: Fetch Realtime Data (runs after seed_data, before run_meta_pipeline)
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# Realtime data: discover APIs, fetch, parse (domain-agnostic)
# ---------------------------------------------------------------------------

# Allowlist of URL prefixes we trust for automated GET requests.
# Claude can suggest any URL, but we only fetch from known-safe origins.
_TRUSTED_URL_PREFIXES = (
    "https://api.coingecko.com/",
    "https://open.er-api.com/",
    "https://www.alphavantage.co/",
    "https://api.fda.gov/",
    "https://clinicaltrials.gov/",
    "https://npiregistry.cms.hhs.gov/",
    "https://api.weatherapi.com/",
    "https://earthquake.usgs.gov/",
    "https://api.open-meteo.com/",
    "https://disease.sh/",
    "https://restcountries.com/",
    "https://api.spacexdata.com/",
    "https://api.nbp.pl/",              # National Bank of Poland (currency)
    "https://data.sec.gov/",
    "https://api.census.gov/",
    "https://api.worldbank.org/",
    "https://pokeapi.co/",
    "https://swapi.dev/",
    "https://api.openbrewerydb.org/",
    "https://api.publicapis.org/",
    "https://datausa.io/",
    "https://api.zippopotam.us/",
    "https://api.genderize.io/",
    "https://api.agify.io/",
    "https://catfact.ninja/",
    "https://dog.ceo/",
    "https://api.frankfurter.app/",
    "https://api.coindesk.com/",
    "https://jsonplaceholder.typicode.com/",  # demo data
    "https://fakestoreapi.com/",
    "https://dummyjson.com/",
    "https://openlibrary.org/",
    "https://gutendex.com/",
    "https://api.tvmaze.com/",
    "https://www.omdbapi.com/",
    "https://api.github.com/",
    "https://api.stackexchange.com/",
    "https://api.nutritionix.com/",
    "https://world.openfoodfacts.org/",
    "https://api.edamam.com/",
    "https://api.football-data.org/",
    "https://www.thecocktaildb.com/",
    "https://www.themealdb.com/",
    "https://api.artic.edu/",
    "https://collectionapi.metmuseum.org/",
    "https://api.nasa.gov/",
    "https://api.exchangerate-api.com/",
)


def _is_trusted_url(url: str) -> bool:
    """Check if a URL starts with a trusted prefix."""
    return any(url.startswith(prefix) for prefix in _TRUSTED_URL_PREFIXES)


def _discover_sources(plan: dict) -> list[dict]:
    """Ask Claude to suggest free public APIs and specific URLs to call."""
    table_descriptions = []
    for t in plan.get("domain_tables", []):
        cols = {k: v for k, v in t.get("columns", {}).items() if k not in ("id", "created_at")}
        table_descriptions.append(
            f"Table '{t['name']}': {t.get('description', '')} — columns: {json.dumps(cols)}"
        )

    # Surface any API keys the user has set, so Claude can suggest APIs that use them
    available_keys = []
    for env_var in ("ALPHA_VANTAGE_API_KEY", "OPENWEATHER_API_KEY", "OMDB_API_KEY", "NASA_API_KEY"):
        if os.environ.get(env_var):
            available_keys.append(env_var)
    key_hint = ""
    if available_keys:
        key_hint = f"\n\nThe user has these API keys available: {', '.join(available_keys)}. You can use them by putting {{{{ENV_VAR_NAME}}}} in the URL."

    prompt = f"""Scenario: "{plan.get('title', '')}" — {plan.get('description', '')}

Tables in this app:
{chr(10).join(table_descriptions)}

Suggest up to 3 **free public APIs** that could provide real data to replace the synthetic data in these tables. For each, provide the exact GET URL(s) to call — fully formed, ready to fetch. Include query parameters in the URL.

Rules:
- Only suggest APIs that are genuinely free (no key required, or key available below)
- URLs must return JSON
- Each URL should return data relevant to at least one table
- Provide 1-5 URLs per source (e.g. one per ticker symbol, or one batch call)
- If no API exists that would meaningfully improve these tables, return {{"sources": []}}
- Prefer well-known, reliable APIs (government data, established services){key_hint}

Return ONLY valid JSON:
{{
  "sources": [
    {{
      "id": "descriptive_name",
      "description": "What data this provides and why it's useful",
      "target_table": "which_table_to_populate",
      "urls": ["https://api.example.com/endpoint?param=value", "..."]
    }}
  ]
}}"""

    text = ask_claude(
        "You suggest free public REST APIs for enriching app data. Return ONLY JSON with exact GET URLs.",
        prompt,
        max_tokens=1024,
    )
    return parse_json(text).get("sources", [])


def _fetch_url(url: str) -> dict | list | None:
    """Fetch a URL and return parsed JSON, or None on failure."""
    # Substitute env vars in URL (e.g. {{ALPHA_VANTAGE_API_KEY}})
    import re
    def _replace_env(match):
        var_name = match.group(1)
        return os.environ.get(var_name, "")
    resolved_url = re.sub(r"\{\{(\w+)\}\}", _replace_env, url)

    if not _is_trusted_url(resolved_url):
        print(f"  Skipping untrusted URL: {resolved_url[:80]}...")
        return None
    try:
        resp = httpx.get(resolved_url, timeout=15, follow_redirects=True)
        if resp.status_code != 200:
            print(f"  URL returned {resp.status_code}: {resolved_url[:80]}...")
            return None
        return resp.json()
    except Exception as e:
        print(f"  Fetch failed for {resolved_url[:80]}...: {e}")
        return None


def _parse_api_responses(
    responses: list[tuple[str, dict | list]],
    target_table: str,
    table_columns: dict[str, str],
    source_description: str,
) -> list[dict]:
    """Ask Claude to extract table rows from raw API responses."""
    # Truncate responses to avoid token blowup
    response_texts = []
    for url, data in responses:
        text = json.dumps(data, default=str)
        if len(text) > 6000:
            text = text[:6000] + "...(truncated)"
        response_texts.append(f"URL: {url}\nResponse:\n{text}")

    cols_no_meta = {k: v for k, v in table_columns.items() if k not in ("id", "created_at", "embedding")}

    prompt = f"""I fetched data from an API. Extract rows that fit this table schema.

Target table: {target_table}
Table columns: {json.dumps(cols_no_meta)}
Source description: {source_description}

API responses:
{chr(10).join(response_texts)}

Extract as many rows as the data supports. Each row should be a dict with keys matching the table columns above.
- Convert data types to match the column types (text, integer, numeric, boolean, timestamptz)
- Skip columns that have no corresponding data in the response
- Do NOT include "id" or "created_at" columns
- Truncate long text values to 500 chars
- If the response contains no usable data for these columns, return {{"rows": []}}

Return ONLY valid JSON:
{{"rows": [{{"column_name": "value", ...}}, ...]}}"""

    text = ask_claude(
        "You extract structured data from API responses into database rows. Return ONLY JSON.",
        prompt,
        max_tokens=8192,
    )
    return parse_json(text).get("rows", [])


def _save_datasources(sources: list[dict], plan: dict, scenario: str) -> str:
    """Save datasources JSON to plans/ directory."""
    os.makedirs(PLAN_DIR, exist_ok=True)
    slug = plan.get("title", scenario)[:60].lower()
    slug = "".join(c if c.isalnum() or c in "-_ " else "" for c in slug).strip().replace(" ", "_")
    path = os.path.join(PLAN_DIR, f"{slug}_datasources.json")
    with open(path, "w") as f:
        json.dump(sources, f, indent=2)
    print(f"  Datasources saved to: {path}")
    return path


def _load_datasources(path: str) -> list[dict]:
    """Load datasources from a JSON file."""
    with open(path) as f:
        return json.load(f)


def _embed_rows(table_name: str, rows: list[dict]):
    """Re-embed rows after inserting real data."""
    try:
        run_sql(f'ALTER TABLE "{table_name}" ADD COLUMN IF NOT EXISTS embedding vector(512);')
        result = supabase.table(table_name).select("*").execute()
        db_rows = result.data or []
        if not db_rows:
            return
        texts = [row_to_text(r) for r in db_rows]
        ids = [r["id"] for r in db_rows]
        batch_size = 20
        embedded = 0
        for i in range(0, len(texts), batch_size):
            batch_texts = texts[i:i + batch_size]
            batch_ids = ids[i:i + batch_size]
            embeddings = voyage_embed(batch_texts)
            for row_id, emb in zip(batch_ids, embeddings):
                emb_str = "[" + ",".join(str(x) for x in emb) + "]"
                run_sql(f"""UPDATE "{table_name}" SET embedding = '{emb_str}'::vector WHERE id = '{row_id}';""")
            embedded += len(embeddings)
        if embedded > 0:
            print(f"  Re-embedded {embedded} rows in: {table_name}")
    except Exception as e:
        print(f"  Warning: Re-embedding failed for {table_name}: {e}")


def _review_sources_interactive(sources: list[dict], plan: dict, scenario: str) -> list[dict]:
    """Show discovered sources to the user and let them edit before fetching."""
    print("\n  ── Realtime Data Sources ──────────────────────────────")
    print(f"  Found {len(sources)} potential data source(s):\n")
    for i, src in enumerate(sources, 1):
        print(f"  [{i}] {src.get('id', '?')} → table '{src.get('target_table', '?')}'")
        print(f"      {src.get('description', '')}")
        for url in src.get("urls", [])[:3]:
            print(f"      • {url}")
        if len(src.get("urls", [])) > 3:
            print(f"      • ...and {len(src['urls']) - 3} more")
        print()

    print("  Options:")
    print("    enter     — accept and fetch all sources above")
    print("    s         — skip realtime data (keep synthetic)")
    print("    e         — edit: open datasources JSON in $EDITOR, then continue")
    print("    a <url>   — add a URL to a source (will prompt for which source)")
    print("    r <num>   — remove source by number")
    print("  ──────────────────────────────────────────────────────")

    while True:
        try:
            choice = input("\n  Your choice: ").strip().lower()
        except (EOFError, KeyboardInterrupt):
            print()
            return sources  # non-interactive, just proceed

        if choice == "" or choice == "y":
            return sources

        elif choice == "s":
            return []

        elif choice == "e":
            # Save to temp file, open in editor, reload
            tmp_path = _save_datasources(sources, plan, scenario)
            editor = os.environ.get("EDITOR", "vi")
            print(f"  Opening {tmp_path} in {editor}...")
            os.system(f'{editor} "{tmp_path}"')
            try:
                sources = _load_datasources(tmp_path)
                print(f"  Reloaded {len(sources)} source(s) from edited file")
            except Exception as e:
                print(f"  Warning: Could not reload edited file: {e}")
            return sources

        elif choice.startswith("a "):
            new_url = choice[2:].strip()
            if not new_url:
                print("  Please provide a URL")
                continue
            if len(sources) == 1:
                sources[0].setdefault("urls", []).append(new_url)
                print(f"  Added URL to '{sources[0].get('id', '?')}'")
            else:
                try:
                    idx = int(input(f"  Add to which source? [1-{len(sources)}]: ").strip()) - 1
                    if 0 <= idx < len(sources):
                        sources[idx].setdefault("urls", []).append(new_url)
                        print(f"  Added URL to '{sources[idx].get('id', '?')}'")
                    else:
                        print("  Invalid source number")
                except (ValueError, EOFError):
                    print("  Invalid input")

        elif choice.startswith("r ") or choice.startswith("r"):
            try:
                num = int(choice.split()[1]) - 1
                if 0 <= num < len(sources):
                    removed = sources.pop(num)
                    print(f"  Removed '{removed.get('id', '?')}'")
                    if not sources:
                        print("  No sources left — will keep synthetic data")
                        return []
                else:
                    print(f"  Invalid number. Choose 1-{len(sources)}")
            except (ValueError, IndexError):
                print("  Usage: r <number>")

        else:
            print("  Unknown option. Press enter to accept, 's' to skip, 'e' to edit")


def fetch_realtime_data(state: PlanState) -> dict:
    """Discover APIs, fetch real data, parse into table rows, replace synthetic data."""
    plan = state["plan"]

    # Source resolution priority:
    # 1. state["datasources"] (from --from-datasources CLI flag)
    # 2. plan["realtime_sources"] (from --from-plan replay)
    # 3. Claude discovery (fresh run)
    sources = state.get("datasources") or []
    source_origin = "--from-datasources"

    if not sources and plan.get("realtime_sources"):
        sources = plan["realtime_sources"]
        source_origin = "plan (embedded)"

    if not sources:
        print("  Discovering realtime data sources...")
        sources = _discover_sources(plan)
        source_origin = "Claude discovery"

        if not sources:
            print("  No realtime data sources found, skipping")
            return {"results": ["realtime_skipped"]}

        # Interactive review — let user see suggestions and edit before fetching
        sources = _review_sources_interactive(sources, plan, state.get("scenario", ""))
        if not sources:
            print("  User skipped all data sources")
            return {"results": ["realtime_skipped"]}

        # Save datasources file and embed in plan
        _save_datasources(sources, plan, state.get("scenario", ""))
        plan["realtime_sources"] = sources
        _save_plan(plan, state.get("scenario", ""))

    print(f"  Realtime data: {len(sources)} source(s) via {source_origin}")

    # Find table column definitions for parsing
    table_defs = {t["name"]: t["columns"] for t in plan.get("domain_tables", [])}

    for source in sources:
        target_table = source.get("target_table", "")
        urls = source.get("urls", [])
        if not target_table or not urls:
            print(f"  Skipping source '{source.get('id', '?')}': missing target_table or urls")
            continue

        table_columns = table_defs.get(target_table)
        if not table_columns:
            print(f"  Skipping source '{source.get('id', '?')}': table '{target_table}' not in plan")
            continue

        # Fetch all URLs for this source
        responses: list[tuple[str, dict | list]] = []
        for url in urls[:10]:  # cap at 10 URLs per source
            data = _fetch_url(url)
            if data is not None:
                responses.append((url, data))

        if not responses:
            print(f"  No successful fetches for source '{source.get('id', '?')}'")
            continue

        print(f"  Fetched {len(responses)}/{len(urls)} URLs for '{source.get('id', '?')}'")

        # Ask Claude to parse the raw API responses into table rows
        try:
            rows = _parse_api_responses(
                responses, target_table, table_columns, source.get("description", "")
            )
        except Exception as e:
            print(f"  Warning: Could not parse responses for '{source.get('id', '?')}': {e}")
            continue

        if not rows:
            print(f"  No rows extracted for '{source.get('id', '?')}'")
            continue

        # Replace synthetic data with real data
        try:
            supabase.table(target_table).delete().gte("created_at", "2000-01-01").execute()
            print(f"  Cleared synthetic data from {target_table}")
            supabase.table(target_table).insert(rows).execute()
            print(f"  Inserted {len(rows)} real rows into {target_table}")

            if VOYAGE_API_KEY:
                _embed_rows(target_table, rows)
        except Exception as e:
            print(f"  Warning: Insert failed for {target_table} (keeping synthetic data): {e}")

    return {"results": ["realtime_data_fetched"]}


# ---------------------------------------------------------------------------
# Node: Write App Config
# ---------------------------------------------------------------------------

def write_app_config(state: PlanState) -> dict:
    broadcast_progress("Configuring dashboard and interface...", 3, 5)
    plan = state["plan"]

    app_config = {
        "title": plan["title"],
        "description": plan.get("description", ""),
        "persona": plan.get("persona", "AI Assistant"),
        "theme": {},
        "layout": plan.get("layout", ["dashboard", "chat_sidebar"]),
        "layout_overrides": {},
        "kpi_config": plan.get("kpi_config", []),
        "chart_config": plan.get("chart_config", []),
        "context_panel_config": {},
        "quick_actions": plan.get("quick_actions", []),
        "form_config": plan.get("form_config") or {},
    }

    # Add layout_overrides
    overrides: dict = {}
    if plan.get("table_display"):
        overrides["table_config"] = plan["table_display"]
    if plan.get("user_context"):
        overrides["user_context"] = plan["user_context"]
    if overrides:
        app_config["layout_overrides"] = overrides

    # Delete old config and insert new
    supabase.table("app_config").delete().neq("id", "00000000-0000-0000-0000-000000000000").execute()
    supabase.table("app_config").insert(app_config).execute()

    print(f"  Wrote app_config: {plan['title']} (layout: {plan.get('layout', [])})")
    return {"results": ["app_config_written"]}


# ---------------------------------------------------------------------------
# Node: Write Agent Config
# ---------------------------------------------------------------------------

def write_agent_config(state: PlanState) -> dict:
    broadcast_progress("Setting up AI pipeline and assistant...", 4, 5)
    plan = state["plan"]

    source_tables = [t["name"] for t in plan.get("domain_tables", [])]

    agent_config = {
        "system_prompt": plan.get("system_prompt", f"You are {plan.get('persona', 'an AI assistant')}."),
        "persona": plan.get("persona", "AI Assistant"),
        "action_label": plan.get("action_label", "Generate Analysis"),
        "tools": [],
        "source_tables": source_tables,
        "model": "claude-sonnet-4-20250514",
        "temperature": 0.3,
        "extraction_schema": plan.get("extraction_schema") or {},
        "validation_rules": plan.get("validation_rules") or {},
        "output_sections": plan.get("output_sections") or {},
        "pipeline_config": plan.get("pipeline_config") or {},
        "pipeline_prompts": plan.get("pipeline_prompts") or {},
        "workflow_config": plan.get("workflow_config") or {},
    }

    # Delete old config and insert new
    supabase.table("agent_config").delete().neq("id", "00000000-0000-0000-0000-000000000000").execute()
    supabase.table("agent_config").insert(agent_config).execute()

    print(f"  Wrote agent_config: persona={plan.get('persona')}, tables={source_tables}")
    return {"results": ["agent_config_written"]}


# ---------------------------------------------------------------------------
# Node: Finalize (trigger real-time refresh)
# ---------------------------------------------------------------------------

def finalize(state: PlanState) -> dict:
    broadcast_progress("Ready! Loading your app...", 5, 5)
    supabase.table("dashboard_updates").insert({
        "component_id": "full_reconfigure",
        "data": {"layout": state["plan"].get("layout", []), "title": state["plan"]["title"]},
    }).execute()

    print(f"\n  Done! Open your app to see: {state['plan']['title']}")
    print(f"  Layout: {state['plan'].get('layout', [])}")
    return {}


# ---------------------------------------------------------------------------
# Python Rule Engine (mirrors pipeline.ts expression evaluator)
# ---------------------------------------------------------------------------

def py_tokenize(expr: str) -> list:
    """Tokenize a math expression into numbers, field names, operators, and keywords."""
    tokens = []
    i = 0
    while i < len(expr):
        if expr[i].isspace():
            i += 1
        elif expr[i] in "+-*/()":
            tokens.append(("op", expr[i]))
            i += 1
        elif expr[i].isdigit() or expr[i] == ".":
            num = ""
            while i < len(expr) and (expr[i].isdigit() or expr[i] == "."):
                num += expr[i]
                i += 1
            tokens.append(("number", float(num)))
        elif expr[i].isalpha() or expr[i] == "_":
            name = ""
            while i < len(expr) and (expr[i].isalnum() or expr[i] == "_"):
                name += expr[i]
                i += 1
            if name in ("AND", "OR"):
                tokens.append(("keyword", name))
            elif name == "true":
                tokens.append(("number", 1.0))
            elif name == "false":
                tokens.append(("number", 0.0))
            else:
                tokens.append(("field", name))
        else:
            i += 1
    return tokens


def _resolve_numeric(val, field_name: str) -> float:
    """Convert a field value to a number. Booleans become 1/0."""
    if isinstance(val, bool):
        return 1.0 if val else 0.0
    if isinstance(val, (int, float)):
        return float(val)
    try:
        return float(val)
    except (ValueError, TypeError):
        raise ValueError(f"Non-numeric field: {field_name} = {val}")


def py_evaluate_math(expression: str, fields: dict) -> float:
    """Evaluate a math expression with field substitution. Safe, no eval()."""
    tokens = py_tokenize(expression)

    resolved = []
    for ttype, tval in tokens:
        if ttype == "field":
            val = fields.get(tval)
            if val is None:
                raise ValueError(f"Missing field: {tval}")
            resolved.append(("number", _resolve_numeric(val, tval)))
        else:
            resolved.append((ttype, tval))

    values = []
    ops = []
    for ttype, tval in resolved:
        if ttype == "number":
            values.append(tval)
            while ops and ops[-1] in ("*", "/"):
                op = ops.pop()
                b = values.pop()
                a = values.pop()
                values.append(a * b if op == "*" else a / b)
        elif ttype == "op":
            ops.append(tval)

    result = values[0] if values else 0.0
    vi = 1
    for op in ops:
        b = values[vi]
        vi += 1
        if op == "+":
            result += b
        elif op == "-":
            result -= b
    return result


def py_evaluate_expression(expression: str, fields: dict):
    """Evaluate an expression. Returns raw value for simple field refs (bool/str), numeric for math."""
    import re
    trimmed = expression.strip()
    # Simple field reference — return raw value to support booleans and strings
    if re.match(r'^[a-zA-Z_][a-zA-Z0-9_]*$', trimmed):
        val = fields.get(trimmed)
        if val is None:
            raise ValueError(f"Missing field: {trimmed}")
        return val
    # Math expression
    return py_evaluate_math(trimmed, fields)


def py_compare(value, operator: str, threshold) -> bool:
    """Compare a value against a threshold. Supports numeric, boolean, and string comparisons."""
    # Boolean operators
    if operator == "is_true":
        return value is True or value == 1 or value == "true"
    if operator == "is_false":
        return value is False or value == 0 or value == "false"
    if operator == "exists":
        return value is not None

    # String "in" check
    if operator == "in":
        options = [s.strip().lower() for s in str(threshold).split(",")]
        return str(value).lower() in options

    # String equality
    if operator == "eq" and (isinstance(value, str) or isinstance(threshold, str)):
        return str(value).lower() == str(threshold).lower()
    if operator == "neq" and (isinstance(value, str) or isinstance(threshold, str)):
        return str(value).lower() != str(threshold).lower()

    # Numeric comparisons
    try:
        nv = 1.0 if value is True else (0.0 if value is False else float(value))
        nt = float(threshold) if threshold is not None else 0.0
    except (ValueError, TypeError):
        return False

    if operator == "eq":
        return nv == nt
    elif operator == "neq":
        return nv != nt
    elif operator == "gt":
        return nv > nt
    elif operator == "gte":
        return nv >= nt
    elif operator == "lt":
        return nv < nt
    elif operator == "lte":
        return nv <= nt
    return False


def py_evaluate_rule(rule: dict, fields: dict) -> tuple:
    """Evaluate a rule with AND/OR support. Returns (passed, value)."""
    import re
    expr = rule["expression"]
    operator = rule["operator"]
    threshold = rule["threshold"]

    # AND compound
    and_parts = re.split(r'\bAND\b', expr, flags=re.IGNORECASE)
    if len(and_parts) > 1:
        all_passed = True
        last_value = 0
        for part in and_parts:
            val = py_evaluate_expression(part.strip(), fields)
            last_value = val
            if not py_compare(val, operator, threshold):
                all_passed = False
        return (all_passed, last_value)

    # OR compound
    or_parts = re.split(r'\bOR\b', expr, flags=re.IGNORECASE)
    if len(or_parts) > 1:
        any_passed = False
        last_value = 0
        for part in or_parts:
            val = py_evaluate_expression(part.strip(), fields)
            last_value = val
            if py_compare(val, operator, threshold):
                any_passed = True
        return (any_passed, last_value)

    # Simple
    value = py_evaluate_expression(expr, fields)
    return (py_compare(value, operator, threshold), value)


# ---------------------------------------------------------------------------
# Node: Run Meta-Pipeline (evaluate rules on seeded data)
# ---------------------------------------------------------------------------

def run_meta_pipeline(state: PlanState) -> dict:
    """Run validation rules against seeded data to pre-compute scores and assign workflow stages."""
    plan = state["plan"]
    rules = plan.get("validation_rules", {}).get("rules", [])
    extraction_fields = plan.get("extraction_schema", {}).get("fields", [])
    workflow_config = plan.get("workflow_config", {})
    pipeline_config = plan.get("pipeline_config", {})

    if not rules:
        print("  Meta-pipeline: no validation rules, skipping")
        return {"results": ["meta_pipeline_skipped"]}

    # Figure out which table has the data to evaluate
    # Priority: workflow item_table > form target_table > first domain table
    item_table = workflow_config.get("item_table")
    if not item_table:
        form_config = plan.get("form_config", {})
        item_table = form_config.get("target_table") if form_config else None
    if not item_table:
        domain_tables = plan.get("domain_tables", [])
        if domain_tables:
            item_table = domain_tables[0]["name"]

    if not item_table:
        print("  Meta-pipeline: no target table found, skipping")
        return {"results": ["meta_pipeline_skipped"]}

    # Fetch seeded rows
    try:
        result = supabase.table(item_table).select("*").execute()
        rows = result.data or []
    except Exception as e:
        print(f"  Meta-pipeline: could not fetch {item_table}: {e}")
        return {"results": ["meta_pipeline_error"]}

    if not rows:
        print(f"  Meta-pipeline: no rows in {item_table}, skipping")
        return {"results": ["meta_pipeline_skipped"]}

    # Field names from extraction schema that map to table columns
    field_names = {f["name"] for f in extraction_fields}

    # Collect all compute_score steps from pipeline config
    score_steps = []
    for step in pipeline_config.get("steps", []):
        if step.get("type") == "compute_score":
            score_steps.append(step.get("config", {}))
    if not score_steps:
        score_steps = [{"weights": {"critical": 3, "warning": 1, "info": 0}}]

    # Workflow stages for score-based assignment
    stages = workflow_config.get("stages", [])
    initial_stage = workflow_config.get("initial_stage")

    updated = 0
    pipeline_results_saved = 0
    for row in rows:
        row_id = row.get("id")
        if not row_id:
            continue

        # Build field dict from row data — preserve booleans and strings
        fields = {}
        for key, val in row.items():
            if key in ("id", "created_at", "stage"):
                continue
            if val is not None:
                if isinstance(val, bool):
                    fields[key] = val
                else:
                    try:
                        fields[key] = float(val)
                    except (ValueError, TypeError):
                        fields[key] = val

        # Evaluate each rule
        total_weight = 0
        earned_weight = 0
        rule_results = []
        default_weights = {"critical": 3, "warning": 1, "info": 0}

        for rule in rules:
            try:
                passed, value = py_evaluate_rule(rule, fields)
                rw = default_weights.get(rule["severity"], 1)
                total_weight += rw
                if passed:
                    earned_weight += rw
                display_val = round(value, 3) if isinstance(value, (int, float)) and not isinstance(value, bool) else value
                fail_msg = None if passed else rule.get("fail_message", "").replace("{{value}}", str(display_val))
                num_value = (1.0 if value is True else 0.0) if isinstance(value, bool) else (float(value) if isinstance(value, (int, float)) else 0.0)
                rule_results.append({
                    "id": rule["id"],
                    "label": rule["label"],
                    "passed": passed,
                    "severity": rule["severity"],
                    "message": fail_msg,
                    "value": round(num_value, 3),
                })
            except Exception:
                # Skip rules that can't be evaluated (missing fields, etc.)
                pass

        # Compute scores — supports multiple score steps with category filters
        all_scores = {}
        primary_score = 100
        for score_cfg in score_steps:
            sw = score_cfg.get("weights", {"critical": 3, "warning": 1, "info": 0})
            cat = score_cfg.get("category")
            score_id = score_cfg.get("score_id")

            filtered = rule_results
            if cat:
                filtered = [r for r in rule_results if rules[[rr["id"] for rr in rules].index(r["id"])].get("category") == cat] if rule_results else []

            tw = sum(sw.get(r["severity"], 1) for r in filtered)
            ew = sum(sw.get(r["severity"], 1) for r in filtered if r["passed"])
            s = round((ew / tw) * 100) if tw > 0 else 100

            if score_id:
                all_scores[score_id] = s
            else:
                primary_score = s

        score = primary_score

        # Build update payload
        update: dict = {}

        # Add risk_score if the table has that column
        table_def = next((t for t in plan.get("domain_tables", []) if t["name"] == item_table), None)
        if table_def:
            columns = table_def.get("columns", {})
            if "risk_score" in columns:
                update["risk_score"] = score
            # Store named scores in their own columns if they exist
            for sid, sval in all_scores.items():
                col_name = f"{sid}_score"
                if col_name in columns:
                    update[col_name] = sval

        # Assign workflow stage based on score if not already in a non-initial stage
        if stages and initial_stage and row.get("stage") == initial_stage:
            # High score (>= 80) = advance to next stage, low score = stay or flag
            critical_fails = sum(1 for r in rule_results if not r["passed"] and r["severity"] == "critical")
            if critical_fails > 0 and len(stages) > 2:
                # Find a "review" or "flagged" stage (second stage typically)
                update["stage"] = stages[1]["id"]
            elif score >= 80 and len(stages) > 1:
                # Auto-advance past initial
                update["stage"] = stages[1]["id"]

        if update:
            try:
                supabase.table(item_table).update(update).eq("id", row_id).execute()
                updated += 1
            except Exception as e:
                print(f"  Meta-pipeline: could not update row {row_id}: {e}")

        # Save pipeline_results for this item so workflow panel can show them
        if rule_results:
            # Build extracted fields section
            field_entries = [
                {"name": k, "label": k.replace("_", " ").title(), "value": v}
                for k, v in fields.items()
                if not isinstance(v, str) or len(v) < 100  # skip long text fields
            ]

            sections = []
            if field_entries:
                sections.append({
                    "id": "extracted_fields",
                    "type": "field_table",
                    "title": "Item Data",
                    "data": {"fields": field_entries},
                })
            sections.append({
                "id": "validation",
                "type": "checklist",
                "title": "Validation Results",
                "data": {"items": rule_results},
            })
            sections.append({
                "id": "score",
                "type": "score",
                "title": "Risk Score",
                "data": {"score": score, "max": 100},
            })

            try:
                supabase.table("pipeline_results").insert({
                    "item_id": row_id,
                    "item_table": item_table,
                    "sections": sections,
                    "score": score,
                    "metadata": {"source": "meta_pipeline", "rules_evaluated": len(rule_results)},
                }).execute()
                pipeline_results_saved += 1
            except Exception as e:
                print(f"  Meta-pipeline: could not save results for {row_id}: {e}")

    print(f"  Meta-pipeline: evaluated {len(rows)} rows, updated {updated}, saved {pipeline_results_saved} pipeline results in {item_table}")
    return {"results": ["meta_pipeline_done"]}


# ---------------------------------------------------------------------------
# Build the graph
# ---------------------------------------------------------------------------

graph = StateGraph(PlanState)

graph.add_node("classify", classify_scenario)
graph.add_node("seed_data", seed_data)
graph.add_node("run_meta_pipeline", run_meta_pipeline)
graph.add_node("write_app_config", write_app_config)
graph.add_node("write_agent_config", write_agent_config)
graph.add_node("fetch_images", fetch_images)
graph.add_node("fetch_realtime_data", fetch_realtime_data)
graph.add_node("finalize", finalize)

graph.add_edge(START, "classify")
graph.add_conditional_edges("classify", fan_out)
# Realtime data replaces synthetic data after tables are seeded, before meta-pipeline scores
graph.add_edge("seed_data", "fetch_realtime_data")
graph.add_edge("fetch_realtime_data", "run_meta_pipeline")
graph.add_edge("run_meta_pipeline", "finalize")
graph.add_edge("write_app_config", "finalize")
graph.add_edge("write_agent_config", "finalize")
graph.add_edge("fetch_images", "finalize")
graph.add_edge("finalize", END)

app = graph.compile()

# ---------------------------------------------------------------------------
# CLI entrypoint
# ---------------------------------------------------------------------------

def convert_md_to_json(md_path: str) -> dict:
    """Convert an edited .md plan summary back to .json using Claude."""
    # Find the corresponding JSON file
    json_path = md_path.replace(".md", ".json")
    if not os.path.exists(json_path):
        print(f"Error: No matching JSON file found at {json_path}")
        sys.exit(1)

    with open(md_path) as f:
        md_content = f.read()
    with open(json_path) as f:
        original_json = json.load(f)

    print("  Converting edited markdown back to JSON...")
    text = ask_claude(
        """You update JSON configuration files based on edited markdown summaries.

You will receive:
1. The ORIGINAL JSON configuration
2. An EDITED markdown summary of that configuration

Your job: Apply every change from the markdown back into the JSON. Return ONLY the updated JSON.

Rules:
- Preserve the exact JSON structure — don't add or remove top-level keys
- If a validation rule was edited (threshold, severity, label), update it in the JSON
- If a table column was added/removed, update domain_tables
- If a pipeline step was added/removed/reordered, update pipeline_config.steps
- If a KPI was changed, update kpi_config
- If text fields were edited (title, description, persona, action_label), update them
- Return the COMPLETE JSON, not a diff""",
        f"ORIGINAL JSON:\n{json.dumps(original_json, indent=2)}\n\nEDITED MARKDOWN:\n{md_content}",
        max_tokens=16384,
    )

    updated = parse_json(text)

    # Validate critical structure
    required_keys = {"title", "layout", "domain_tables"}
    missing = required_keys - set(updated.keys())
    if missing:
        print(f"  Warning: Updated JSON missing keys: {missing}. Using original values.")
        for key in missing:
            updated[key] = original_json[key]

    # Validate domain_tables have required fields
    for t in updated.get("domain_tables", []):
        if "name" not in t or "columns" not in t:
            print(f"  Warning: Invalid table definition found, skipping validation")
            break

    # Save the updated JSON
    with open(json_path, "w") as f:
        json.dump(updated, f, indent=2)
    print(f"  Updated JSON saved to: {json_path}")

    return updated


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage:")
        print('  uv run python meta_agent.py "Your scenario here"')
        print('  uv run python meta_agent.py --from-plan plans/my_plan.json')
        print('  uv run python meta_agent.py --from-md plans/my_plan.md')
        print('  uv run python meta_agent.py --from-plan plans/my_plan.json --from-datasources plans/my_plan_datasources.json')
        print()
        print("  --from-plan         Load a JSON plan and re-run all downstream steps")
        print("  --from-md           Convert an edited markdown summary back to JSON, then run")
        print("  --from-datasources  Load edited datasources JSON (skips Claude source selection)")
        sys.exit(1)

    # Parse flags — scan all argv for flag pairs
    preloaded_plan = None
    preloaded_datasources = None
    args = sys.argv[1:]

    # Extract --from-datasources from anywhere in argv
    if "--from-datasources" in args:
        idx = args.index("--from-datasources")
        if idx + 1 >= len(args):
            print("Error: --from-datasources requires a path to a JSON file")
            sys.exit(1)
        ds_path = args[idx + 1]
        if not os.path.exists(ds_path):
            print(f"Error: Datasources file not found: {ds_path}")
            sys.exit(1)
        preloaded_datasources = _load_datasources(ds_path)
        print(f"  Loaded {len(preloaded_datasources)} datasource(s) from: {ds_path}")
        # Remove the flag and its value from args
        args = args[:idx] + args[idx + 2:]

    if not args:
        if preloaded_datasources:
            print("Error: --from-datasources must be combined with --from-plan or a scenario")
            sys.exit(1)
        print("Error: No scenario or --from-plan provided")
        sys.exit(1)

    if args[0] == "--from-md":
        if len(args) < 2:
            print("Error: --from-md requires a path to a .md file")
            sys.exit(1)
        md_path = args[1]
        if not os.path.exists(md_path):
            print(f"Error: File not found: {md_path}")
            sys.exit(1)
        print(f"\nConverting edited markdown: {md_path}\n")
        preloaded_plan = convert_md_to_json(md_path)
        # Regenerate the markdown summary from the updated JSON
        _save_plan(preloaded_plan, preloaded_plan.get("title", ""))
        scenario = preloaded_plan.get("title", "from-md")
        print(f"\n  Re-running with updated plan...\n")

    elif args[0] == "--from-plan":
        if len(args) < 2:
            print("Error: --from-plan requires a path to a plan JSON file")
            sys.exit(1)
        plan_path = args[1]
        if not os.path.exists(plan_path):
            print(f"Error: Plan file not found: {plan_path}")
            sys.exit(1)
        with open(plan_path) as f:
            preloaded_plan = json.load(f)
        scenario = preloaded_plan.get("title", "from-plan")
        print(f"\nMeta-agent re-running from plan: {plan_path}\n")
    else:
        scenario = " ".join(args)
        print(f"\nMeta-agent starting for: \"{scenario}\"\n")

    # Ensure DB columns exist
    print("  Running migrations...")
    ensure_columns()

    initial_state: dict = {"scenario": scenario, "results": []}
    if preloaded_plan:
        initial_state["plan"] = preloaded_plan
    if preloaded_datasources:
        initial_state["datasources"] = preloaded_datasources

    result = app.invoke(initial_state)

    print(f"\nCompleted: {result['results']}")
