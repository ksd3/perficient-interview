# Composable AI Platform – Detailed Architecture Reference

## How It Works (30-Second Overview)

```
You describe a scenario in plain English
        ↓
meta_agent.py (LangGraph) calls Claude ONCE to generate a full JSON config
        ↓
3 nodes run IN PARALLEL: create tables + seed data, write app config, write agent config
        ↓
1 node pre-computes scores on seeded data
        ↓
Next.js app reads configs from Supabase and renders a fully working app
```

---

## 1. Meta-Agent (LangGraph State Graph)

```
START ──→ classify_scenario ──→ fan_out ──┬──→ run_migrations + seed_data + embed ──┐
                                          ├──→ write_app_config                     ├──→ run_meta_pipeline ──→ finalize ──→ END
                                          └──→ write_agent_config                   ┘
```

### Node: `classify_scenario`
**Input:** A plain-English scenario string
**Output:** A single JSON object containing ALL of the config below
**How:** One Claude call with a detailed system prompt. The prompt contains the full schema, every option, and 11 rules the LLM must follow.

### Node: `run_migrations` + `seed_data`
- Creates domain tables via raw SQL (`psycopg2`)
- Seeds 8-15 realistic rows per table via Claude
- Adds `embedding vector(512)` column to each table
- Calls Voyage AI to embed each row, stores in pgvector
- Creates IVFFlat index for similarity search

### Node: `write_app_config`
Writes to `app_config` table: title, layout, KPIs, charts, table display, quick actions, form config.

### Node: `write_agent_config`
Writes to `agent_config` table: system prompt, persona, extraction schema, validation rules, pipeline config, output sections, workflow config.

### Node: `run_meta_pipeline`
Runs the Python rule engine against every seeded row to pre-compute scores and assign workflow stages. Mirrors the TypeScript pipeline logic exactly.

### Node: `finalize`
Inserts a `dashboard_updates` row to trigger Supabase Realtime refresh in the frontend.

---

## 2. Layout & UI Architecture

### Navigation Model

The app uses a **sidebar navigation** pattern:

```
┌──────────┬────────────────────────────┬─────────────┐
│          │                            │             │
│  Left    │     Main Content Area      │   Chat      │
│  Sidebar │     (one panel at a time)  │   Sidebar   │
│  Nav     │                            │   (380px)   │
│  (220px) │                            │             │
│          │                            │             │
│ ┌──────┐ │                            │             │
│ │ Logo │ │                            │             │
│ │ Nav  │ │                            │             │
│ │ Items│ │                            │             │
│ │      │ │                            │             │
│ │Persona│ │                            │             │
│ └──────┘ │                            │             │
└──────────┴────────────────────────────┴─────────────┘
```

**Layout rules:**
- **Multi-panel layouts (2+ main panels):** Left sidebar nav shows, one panel visible at a time, click nav to switch
- **Single-panel layouts:** No sidebar, inline title + single panel fills the screen
- **Chat-only layouts (`chat_sidebar` only):** Full-width chat, no sidebar
- **Auto-navigate:** After document/form pipeline completes, automatically switches to the `workflow` tab if present

### Color Scheme

OKLCH color space with a **teal primary + warm neutral** palette:
- Primary: teal (`oklch(0.52 0.14 175)`)
- Background: near-neutral warm white (`oklch(0.985 0.001 250)`)
- Cards: pure white
- Borders/muted: true neutral grey (hue 250, very low chroma)
- Chart colors: 5 distinct hues — teal, violet, rose, amber, green
- Full dark mode variant with matching teal primary

### Panel Components

The classifier picks a combination of these panels:

| Component | Nav Label | When to use | What it renders |
|-----------|-----------|-------------|-----------------|
| `document_upload` | Intake | User uploads/pastes documents for analysis | File drop zone + paste area → triggers `/api/analyze` pipeline |
| `form` | Intake | User fills out structured data | Multi-section form with validation → triggers `/api/submit` pipeline |
| `workflow` | Workflow | Items move through stages with actions | Item cards with expand/collapse, stage filter pills, pipeline results |
| `dashboard` | Dashboard | Monitoring, analytics, overview | KPI cards + charts + data table |
| `research` | Research | Investigation, due diligence | Search bar → AI generates research report with sources |
| `chat_sidebar` | *(always visible)* | Always-available AI assistant | Streaming chat, context-aware, has access to all domain data |

### Workflow Stage Filtering

When viewing the Workflow panel, stage filter pills appear at the top:

```
[All (12)] [Awaiting Triage (5)] [Under Review (3)] [Approved (2)] [Denied (2)]
```

- **"All"** shows every item (default)
- Clicking a stage filters to only items in that stage
- Clicking the active filter again resets to "All"
- Counts update dynamically from Supabase Realtime
- Works generically for ANY workflow — stages come from `workflow_config.stages`

### Typical Combinations

| Scenario Type | Layout |
|---------------|--------|
| Document analysis (compliance, audit) | `document_upload`, `workflow`, `dashboard`, `chat_sidebar` |
| Process/intake (claims, onboarding) | `form`, `workflow`, `dashboard`, `chat_sidebar` |
| Monitoring (risk, ops) | `dashboard`, `chat_sidebar` |
| Data collection (registration) | `form`, `dashboard` |
| Investigation (due diligence) | `research`, `dashboard`, `chat_sidebar` |
| Advisory (support bot) | `chat_sidebar` only |
| Full process (loan origination) | `form`, `document_upload`, `workflow`, `dashboard`, `chat_sidebar` |

---

## 3. Classifier Output – Every Config Block in Detail

### 3.1 `domain_tables`
Defines the Postgres tables to create.

```
name:        snake_case table name
description: what the table holds
columns:     { col_name: "text | integer | numeric | boolean | timestamptz" }
sample_rows: 8-15 (how many rows Claude generates)
```

**Auto-added columns** (not in config): `id uuid`, `created_at timestamptz`, `embedding vector(512)`

**Rules:**
- If `workflow` is in layout, the `item_table` MUST have a `stage text` column
- If `form` is in layout, form field names MUST match table column names
- If KPIs reference a column, it MUST exist here

### 3.2 `form_config`
Only generated when `form` is in layout.

```
title:                Form heading
sections[]:
  label:              Section heading
  fields[]:
    name:             field_name (must match table column)
    label:            "Display Label"
    type:             text | number | date | select | checkbox | textarea | email | phone
    required:         true | false
    options:          ["opt1", "opt2"]  ← only for select type
target_table:         which domain_table to insert into
post_submit_pipeline: true | false  ← if true, runs the analysis pipeline after form submit
```

### 3.3 `extraction_schema`
Defines what the LLM extracts from documents/form data.

```
fields[]:
  name:        field_name (MUST match what validation_rules reference)
  type:        string | number | boolean | enum | date
  description: "What to extract"
  required:    true | false
  options:     ["opt1", "opt2"]  ← only for enum type
```

### 3.4 `validation_rules`
The deterministic rule engine. No LLM involved — pure math/logic.

```
rules[]:
  id:           unique_rule_id
  label:        "Human-Readable Name"
  expression:   SEE EXPRESSION TYPES BELOW
  operator:     SEE OPERATORS BELOW
  threshold:    number | string | comma-separated list | ignored
  severity:     critical | warning | info
  fail_message: "Text with {{value}} interpolation"
  category:     optional grouping for multi-score (e.g. "fraud", "compliance")
```

#### Expression Types

| Type | Example | What it does |
|------|---------|--------------|
| Simple field ref | `age` | Returns the raw value (number, boolean, or string) |
| Math expression | `debt_amount / borrower_income` | Evaluates arithmetic with field substitution |
| Compound AND | `lives_alone AND age` | Both sides must pass the operator/threshold |
| Compound OR | `chest_pain OR shortness_of_breath` | Either side must pass |

**Math operators supported:** `+`, `-`, `*`, `/`, parentheses
**Tokenizer:** Custom safe tokenizer, no `eval()`. Handles field names, numbers, operators.

#### Operators

| Operator | Threshold | Use for |
|----------|-----------|---------|
| `gt` | number | `age gt 65` → true if age > 65 |
| `gte` | number | `score gte 80` → true if score >= 80 |
| `lt` | number | `dti lt 0.43` → true if DTI < 0.43 |
| `lte` | number | `temperature lte 40` |
| `eq` | number or string | `status eq "approved"` or `count eq 5` |
| `neq` | number or string | `result neq "negative"` |
| `is_true` | *(ignored)* | `is_covered is_true` → true if field is true/1/"true" |
| `is_false` | *(ignored)* | `police_report is_false` → true if field is false/0/"false" |
| `in` | comma-separated | `admission_type in "emergent,urgent"` |

#### Severity & Scoring Weight

| Severity | Default Weight | Meaning |
|----------|---------------|---------|
| `critical` | 3 | Must-fix, blocks approval |
| `warning` | 1 | Flag for review |
| `info` | 0 | Informational, doesn't affect score |

**Score formula:** `score = (earned_weight / total_weight) * 100`
A rule that PASSES earns its weight. A rule that FAILS earns 0.

#### Category (Multi-Score)

When rules have a `category` field, they can be scored separately:
- Rules tagged `category: "fraud"` → scored by a `compute_score` step with `config.category: "fraud"`
- Rules tagged `category: "compliance"` → scored separately
- Rules without a category → scored by the default (uncategorized) `compute_score` step

**When to use multi-score:** 2+ distinct risk dimensions (fraud + complexity, clinical + social, credit + compliance)
**When to use single score:** One risk dimension (overall risk, single compliance check)

### 3.5 `pipeline_config`
Defines the processing pipeline. Steps execute IN ORDER.

```
steps[]:
  id:     unique step id
  type:   SEE STEP TYPES BELOW
  config: step-specific config (optional)
```

#### Pipeline Step Types

| Step Type | Required? | What It Does | Config Options |
|-----------|-----------|--------------|----------------|
| `llm_extract` | YES (always first) | Claude extracts structured fields from document text | *(none)* |
| `rule_engine` | YES (after extract) | Runs all validation rules against extracted fields | *(none)* |
| `compute_score` | YES (after rules) | Computes score from rule pass/fail results | `weights`: `{critical: 3, warning: 1, info: 0}` |
| | | | `category`: filter rules by this category |
| | | | `score_id`: name for this score (e.g. `"fraud"`) |
| | | | `label`: display name (e.g. `"Fraud Risk Score"`) |
| `web_search` | OPTIONAL | Generates search queries → uses Anthropic web search tool | `max_searches`: 2-4 |
| | | | `focus`: "what to search for" |
| `vector_search` | OPTIONAL | Embeds extracted data → pgvector cosine similarity | `table`: which domain_table to search |
| | | | `top_k`: 3-5 results |
| `record_match` | OPTIONAL (after vector_search) | LLM evaluates extracted data against each retrieved record's criteria. Returns per-record match score + met/unmet/unclear criteria | `match_instructions`: "what to compare" |
| | | | `criteria_fields`: `["key_inclusion", "key_exclusion"]` |
| | | | `label_field`: field to use as record label |
| `llm_summarize` | YES (near end) | Claude writes summary paragraph + recommendations list | *(none)* |
| `llm_generate` | OPTIONAL (last) | Claude generates a formal document (report, letter, SAR) | `document_type`: "Triage Report" etc. |
| | | | `instructions`: additional generation instructions |

#### Pipeline Ordering Rules
1. `llm_extract` must be FIRST (everything depends on extracted fields)
2. `rule_engine` must come AFTER extract
3. `compute_score` must come AFTER rule_engine
4. `web_search` and `vector_search` go AFTER extract but BEFORE summarize
5. `record_match` goes AFTER `vector_search` (it needs the retrieved records)
6. `llm_summarize` goes AFTER all scoring/search/match steps (it uses their results)
7. `llm_generate` goes LAST (it uses the summary)

#### Example Pipelines

**Simple compliance check (no document generation):**
```
extract → rule_engine → compute_score → summarize
```

**Claims triage with dual scoring + similar claims:**
```
extract → rule_engine → compute_score(fraud) → compute_score(complexity) → vector_search → summarize → llm_generate
```

**Clinical trial matching (per-record eligibility):**
```
extract → rule_engine → compute_score → vector_search → record_match → summarize → llm_generate
```

**Loan application with web research + similar loans:**
```
extract → rule_engine → compute_score → web_search → vector_search → summarize → llm_generate
```

**Simple monitoring (no rules, just extraction):**
```
extract → summarize
```

### 3.6 `output_sections`
Defines what sections appear in the analysis results panel.

```
sections[]:
  id:     unique section id
  type:   SEE SECTION TYPES BELOW
  title:  "Display Title"
  source: where data comes from
```

#### Section Types

| Type | Source | What It Renders |
|------|--------|-----------------|
| `field_table` | `"extraction"` | Table of extracted field names + values |
| `checklist` | `"validation"` | List of rules with pass/fail icons + severity colors |
| `score` | `"score"` | Score gauge (0-100) for default score |
| `score` | `"score.fraud"` | Score gauge for named score (multi-score) |
| `score` | `"score.complexity"` | Score gauge for named score (multi-score) |
| `text` | `"summary"` | Summary paragraph from llm_summarize |
| `list` | `"summary.recommendations"` | Bullet list of recommendations |
| `document` | `"document"` | Full markdown document from llm_generate |
| `web_search_results` | `"web_search"` | List of web search results with titles + snippets |
| `web_search_results` | `"similar"` | List of similar records from vector_search |
| `kv_pairs` | `"extraction"` | Key-value pair display (alternative to field_table) |
| `record_match` | `"record_match"` | Ranked cards per record: match %, criteria met (green), unmet (red), unclear (amber) |

**Rules:**
- Only include `document` if pipeline has `llm_generate`
- Only include `web_search_results` with source `"web_search"` if pipeline has `web_search`
- Only include `web_search_results` with source `"similar"` if pipeline has `vector_search`
- Only include `record_match` if pipeline has `record_match`

#### Section Rendering Layout

The frontend groups output sections intelligently:

```
┌─────────────────────────────────────────────┐
│  HERO SCORES (compact side-by-side cards)   │
│  [Fraud: 72/100] [Complexity: 45/100]       │
├─────────────────────────────────────────────┤
│  ALWAYS VISIBLE                             │
│  Summary paragraph + Recommendations list   │
├─────────────────────────────────────────────┤
│  TABBED DETAILS (if 4+ sections total)      │
│  [Extracted Data] [Validation] [Web] [Doc]  │
│  ┌─────────────────────────────────────┐    │
│  │  Currently selected tab content     │    │
│  └─────────────────────────────────────┘    │
└─────────────────────────────────────────────┘
```

- **≤3 sections:** All stacked vertically, no tabs
- **4+ sections:** Scores at top as compact cards, summary always visible, remaining sections in tabs
- **Multi-score:** Each `score` section renders as a side-by-side card in the hero area
- **Record match:** Renders as ranked cards with color-coded progress bars (green ≥70%, amber ≥40%, red <40%) and criteria lists

### 3.7 `workflow_config`
Only generated when `workflow` is in layout.

```
stages[]:
  id:         stage_id (must match values in the table's "stage" column)
  label:      "Display Name"
  actions[]:
    id:         action_id
    label:      "Button Text"
    next_stage: which stage to transition to
    style:      "default" | "destructive"
    confirm:    true | false (show confirmation dialog?)
  terminal:   true | false (no actions = end state)

initial_stage: id of the first stage
item_table:    which domain_table holds the workflow items (MUST have "stage" column)
```

**Example workflow stages:**
```
intake → review → [approve → approved(terminal)]
                   [reject → denied(terminal)]
                   [escalate → escalated → review]
```

### 3.8 `kpi_config`
Only generated when `dashboard` is in layout. Typically 3-5 KPIs.

```
label:     "KPI Display Name"
table:     which domain_table to query
aggregate: count | sum | avg | count_ratio
field:     column name (null for count and count_ratio)
format:    number | currency | percent
filter:    PostgREST filter string | null
```

#### Aggregates

| Aggregate | What It Does | Field Required? | Example |
|-----------|-------------|-----------------|---------|
| `count` | Counts rows matching filter | No | Total Applications: `count` with no filter |
| `sum` | Sums a numeric column | Yes | Total Loan Value: `sum` on `loan_amount` |
| `avg` | Averages a numeric column | Yes | Avg Processing Time: `avg` on `days_to_decision` |
| `count_ratio` | `(filtered count / total count) * 100` | No | Approval Rate: `count_ratio` with `filter: "stage.eq.approved"` |

#### Filter Syntax (PostgREST)

| Filter | Meaning |
|--------|---------|
| `col.eq.value` | column equals value |
| `col.neq.value` | column not equals |
| `col.gt.value` | column greater than |
| `col.gte.value` | column greater than or equal |
| `col.lt.value` | column less than |
| `col.in.(a,b,c)` | column in list |
| `col.not.is.null` | column is not null |
| `col.is.null` | column is null |
| `null` | no filter (all rows) |

### 3.9 `chart_config`
Only generated when `dashboard` is in layout. Typically 2-4 charts.

```
title:   "Chart Title"
type:    bar | line | pie | area
table:   which domain_table to query
x_field: column for x-axis / labels
y_field: column for y-axis / values
```

### 3.10 `table_display`
Configures the data table shown in the dashboard.

```
source_table: which domain_table
columns:      ["col1", "col2", "col3"]  ← which columns to show
```

### 3.11 `quick_actions`
Buttons in the chat sidebar that send pre-defined prompts. Typically 2-4.

```
label:  "Button Text"
prompt: "What the AI should be asked when clicked"
```

### 3.12 `system_prompt`
The system prompt for the AI chat assistant. Should be detailed and domain-specific.

---

## 4. Runtime Pipeline (What Happens When a User Submits a Document)

```
User uploads document
        ↓
POST /api/analyze { document: "text..." }
        ↓
Load agent_config from Supabase (extraction_schema, validation_rules, pipeline_config, output_sections)
        ↓
Load reference data (up to 50 rows from each domain_table)
        ↓
Execute pipeline steps in order:

  ┌─────────────────────────────────────────────────────────┐
  │ 1. llm_extract                                         │
  │    Claude reads document + extraction_schema fields     │
  │    Returns: { field_name: value, ... }                  │
  │    Reference data injected for cross-referencing        │
  │    maxOutputTokens: 2048, document capped at 3000 chars │
  ├─────────────────────────────────────────────────────────┤
  │ 2. rule_engine                                         │
  │    For each rule: tokenize expression → substitute      │
  │    field values → evaluate math → compare result        │
  │    Supports AND/OR splitting                            │
  │    Returns: [{ id, label, passed, severity, message }]  │
  │    NO LLM CALL — pure deterministic logic               │
  ├─────────────────────────────────────────────────────────┤
  │ 3. compute_score (one or more)                         │
  │    Filters rules by category (if set)                   │
  │    Sums weights of passed/total rules                   │
  │    Returns: score 0-100                                 │
  │    NO LLM CALL — pure math                              │
  ├─────────────────────────────────────────────────────────┤
  │ 4. web_search (optional)                               │
  │    Claude generates search queries (1 LLM call)         │
  │    Anthropic web search tool executes each query         │
  │    Returns: [{ query, title, url, snippet }]            │
  ├─────────────────────────────────────────────────────────┤
  │ 5. vector_search (optional)                            │
  │    Voyage AI embeds extracted data                       │
  │    pgvector cosine similarity against domain table       │
  │    Fallback: client-side cosine if SQL function fails    │
  │    Returns: [{ record fields... }]                      │
  │    NO LLM CALL — embedding API + SQL                    │
  ├─────────────────────────────────────────────────────────┤
  │ 5b. record_match (optional, after vector_search)       │
  │    Claude evaluates input against EACH retrieved record  │
  │    Builds compact record summaries from criteria fields  │
  │    Returns per-record: match_score, criteria met/unmet   │
  │    maxOutputTokens: 2048                                │
  │    Use case: "does this patient match Trial A, B, C?"    │
  ├─────────────────────────────────────────────────────────┤
  │ 6. llm_summarize                                       │
  │    Claude receives: extracted fields + rule results +    │
  │    scores + web results + similar records                │
  │    Returns: { summary: "...", recommendations: [...] }  │
  │    maxOutputTokens: 2048, document capped at 1000 chars │
  ├─────────────────────────────────────────────────────────┤
  │ 7. llm_generate (optional)                            │
  │    Claude receives: scores + failed rules + summary +   │
  │    recommendations + extracted data (compact)            │
  │    Returns: full markdown document                       │
  │    maxOutputTokens: 4096                                │
  │    Does NOT re-inject reference/web/similar context      │
  └─────────────────────────────────────────────────────────┘
        ↓
Build output sections from pipeline context
        ↓
Return JSON to frontend → render in results panel
```

### Graceful Degradation
Each step after `llm_extract` is wrapped in try/catch. If a step fails (e.g. rate limit), it's marked as `step_id:failed` in metadata and the pipeline continues. The frontend renders whatever sections have data.

### Token Budget (30k tokens/min free tier)
- Extract: ~3-5k input tokens
- Summarize: ~2-3k input tokens
- Generate: ~2-3k input tokens
- Web search query gen: ~500 input tokens
- Web search execution: ~1-2k per query
- Total for extract + rules + score + summarize + generate: ~8-12k tokens across 3 LLM calls

---

## 5. External Services

| Service | What For | API | Rate Limit |
|---------|----------|-----|------------|
| Claude Sonnet 4 | All LLM calls (classify, extract, summarize, generate, chat) | Anthropic Messages API | 30k tokens/min (free) |
| Voyage AI | Embedding generation (`voyage-3-lite`, 512 dims) | `POST /v1/embeddings` | Free tier |
| Anthropic Web Search | Real-time web search from within Claude | `anthropic.tools.webSearch_20250305()` | Included in Claude calls |
| Supabase | PostgreSQL + Realtime + Row Level Security | REST + Realtime WebSocket | Free tier |
| pgvector | Vector similarity search | SQL `<=>` operator (cosine distance) | N/A (runs in Postgres) |

---

## 6. Frontend Tech Stack

| Layer | Technology |
|-------|-----------|
| Framework | Next.js 16 (App Router) |
| Language | TypeScript |
| UI Components | shadcn/ui |
| Styling | Tailwind CSS v4 |
| AI Chat | Vercel AI SDK v6 (`useChat`, `generateText`) |
| State | React 19 |
| Data | Supabase JS client + Realtime subscriptions |

---

## 7. API Routes

| Route | Method | Trigger | What It Does |
|-------|--------|---------|--------------|
| `/api/analyze` | POST | Document upload | Runs full pipeline on document text |
| `/api/submit` | POST | Form submit | Inserts row + optionally runs pipeline |
| `/api/analyze-item` | POST | Workflow "Run Analysis" | Runs pipeline on an existing workflow item |
| `/api/chat` | POST | Chat message | Streaming AI response with domain context |
| `/api/action` | POST | Workflow button click | Updates item stage + logs activity |
| `/api/create-item` | POST | Manual item creation | Creates new workflow item |
| `/api/research` | POST | Research search | AI-generated research report |

---

## 8. Scenario → Config Mapping (How the Platform Handles Real Use Cases)

Each scenario described in plain English maps to a specific combination of layout, pipeline, workflow, and rules. The classifier makes all these decisions in ONE call.

### Insurance Claims Triage
**Layout:** `document_upload`, `workflow`, `dashboard`, `chat_sidebar`
**Pipeline:** `extract → rule_engine → compute_score(fraud) → compute_score(complexity) → vector_search → summarize → llm_generate`
**Multi-score:** Yes — fraud risk + complexity are independent dimensions
**Workflow:** `intake → triage → [approve → approved | reject → denied | escalate → escalated]`
**Output:** Dual score gauges, checklist, similar claims, triage report
**Key rules:** `claim_amount gt 10000` (critical), `has_police_report is_false` (warning), `claim_amount / policy_limit gt 0.8` (critical)

### Loan Origination / Underwriting
**Layout:** `form`, `workflow`, `dashboard`, `chat_sidebar`
**Pipeline:** `extract → rule_engine → compute_score → web_search → vector_search → summarize → llm_generate`
**Workflow:** `submitted → review → [approve → approved | reject → denied]`
**Output:** Score gauge, checklist, web research, similar loans, underwriting report
**Key rules:** `debt_amount / borrower_income lt 0.43` (critical), `credit_score gte 620` (critical), `employment_verified is_true` (warning)

### Clinical Trial Matching
**Layout:** `document_upload`, `workflow`, `dashboard`, `chat_sidebar`
**Pipeline:** `extract → rule_engine → compute_score → vector_search → record_match → summarize → llm_generate`
**Record match:** `criteria_fields: ["inclusion_criteria", "exclusion_criteria"]`, `label_field: "trial_name"`, `match_instructions: "Evaluate patient eligibility against each trial's inclusion/exclusion criteria"`
**Output:** Score gauge, record match cards (per-trial eligibility with met/unmet criteria), eligibility report

### Prior Authorization
**Layout:** `document_upload`, `workflow`, `dashboard`, `chat_sidebar`
**Pipeline:** `extract → rule_engine → compute_score → vector_search → summarize → llm_generate`
**Workflow:** `submitted → clinical_review → [approve → approved | deny → denied | peer_review → peer_review → clinical_review]`
**Output:** Score gauge, checklist, similar authorizations, determination letter
**Key rules:** `medical_necessity_documented is_true` (critical), `in_network is_true` (warning)

### Clinical Documentation (Transcript → Note)
**Layout:** `document_upload`, `chat_sidebar`
**Pipeline:** `extract → rule_engine → compute_score → summarize → llm_generate`
**Single panel:** No workflow needed — one-shot document generation
**Output:** Score gauge (documentation quality), checklist (SOAP completeness), formatted clinical note
**Key rules:** `chief_complaint neq ""` (critical), `assessment neq ""` (critical), `plan neq ""` (critical)

### Retirement Planning / Advisory
**Layout:** `form`, `dashboard`, `chat_sidebar`
**Pipeline:** `extract → rule_engine → compute_score → summarize → llm_generate`
**No workflow:** Advisory output, not a process
**Output:** Score gauge (retirement readiness), checklist, personalized retirement report
**Key rules:** `annual_savings / annual_income gte 0.15` (warning), `has_employer_match is_true` (info)

### Compliance / Regulatory Review
**Layout:** `document_upload`, `workflow`, `dashboard`, `chat_sidebar`
**Pipeline:** `extract → rule_engine → compute_score(regulatory) → compute_score(operational) → web_search → summarize → llm_generate`
**Multi-score:** Regulatory compliance vs operational risk
**Output:** Dual scores, checklist, regulatory web search results, compliance report

### SDOH Screening + CBO Matching
**Layout:** `form`, `workflow`, `dashboard`, `chat_sidebar`
**Pipeline:** `extract → rule_engine → compute_score → vector_search → record_match → summarize`
**Record match:** CBO programs matched against patient social determinant needs
**Output:** Score gauge (screening risk), CBO match cards, referral summary
**Known gap:** No voice AI — form-based intake only (but chat sidebar can do conversational screening)

---

## 9. Platform Capabilities at a Glance

| Capability | Status | How |
|-----------|--------|-----|
| One-shot app generation from English | Done | Single Claude call → full JSON config |
| Parallel infrastructure setup | Done | LangGraph fan-out: tables + app config + agent config simultaneously |
| Deterministic scoring (no LLM) | Done | Custom tokenizer + precedence-aware math engine, no `eval()` |
| Multi-dimensional scoring | Done | `category` field on rules + multiple `compute_score` steps |
| Document analysis pipeline | Done | 7 step types, configurable order, graceful degradation |
| One-to-many record matching | Done | `record_match` step: input vs N retrieved records with per-record criteria |
| Vector similarity search | Done | Voyage AI embeddings + pgvector cosine similarity |
| Real-time web research | Done | Anthropic web search tool within Claude calls |
| Workflow state machine | Done | Configurable stages/actions/transitions, stage filtering in UI |
| Live dashboards | Done | KPIs + charts + data tables from Supabase Realtime |
| AI chat assistant | Done | Streaming chat with full domain context access |
| Form-based intake | Done | Multi-section forms, field validation, auto-pipeline trigger |
| Sidebar navigation | Done | Clean nav for multi-panel layouts, auto-tab-switch after pipeline |
| Dark mode | Done | Full OKLCH dark theme variant |
| Graceful degradation | Done | Pipeline continues on step failure, partial results rendered |
| Token-optimized (free tier) | Done | ~8-12k tokens across 3 LLM calls, fits 30k/min budget |
