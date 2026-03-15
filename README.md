# Meta-Agent: Scenario-Driven AI App Generator

A LangGraph-powered meta-agent that takes a plain-English scenario (e.g. *"Claims processing for a health insurer"*) and generates a fully functional AI application — complete with database tables, sample data, validation rules, an AI pipeline, and a composable Next.js frontend.

## How it works

```
"Wealth management portfolio tracker"
        │
        ▼
┌─────────────────┐
│  meta_agent.py   │  ← LangGraph orchestrator
│                  │
│  1. Classify     │  Claude designs layout, tables, rules, pipeline
│  2. Seed data    │  Creates Postgres tables, generates sample rows
│  3. Fetch real   │  Discovers free APIs, fetches live data (interactive)
│  4. Score        │  Runs validation rules, computes risk scores
│  5. Configure    │  Writes app_config + agent_config to Supabase
│  6. Finalize     │  Triggers UI refresh via realtime
└─────────────────┘
        │
        ▼
┌─────────────────┐
│  interview-app/  │  ← Next.js frontend (reads config from Supabase)
│                  │
│  • Dashboard     │  KPIs, charts, data tables
│  • Forms         │  Structured data entry
│  • Doc upload    │  AI-powered document analysis pipeline
│  • Workflow      │  Stage transitions (approve, reject, escalate)
│  • Research      │  Search + AI-generated reports
│  • Chat sidebar  │  Context-aware AI assistant
└─────────────────┘
```

The meta-agent writes configuration to Supabase; the frontend reads it and renders the appropriate components. Change the scenario, re-run, and you get a completely different app.

---

## Prerequisites

- **Python 3.13+** and [uv](https://docs.astral.sh/uv/) (Python package manager)
- **Node.js 18+** and [pnpm](https://pnpm.io/)
- **Supabase project** (free tier works) — [supabase.com](https://supabase.com)
- **Anthropic API key** — [console.anthropic.com](https://console.anthropic.com)

---

## 1. Clone the repo

```bash
git clone https://github.com/ksd3/perficient.git
cd perficient
```

## 2. Set up Supabase

Create a new project at [supabase.com](https://supabase.com/dashboard). Then run this SQL in the **SQL Editor** to create the core tables:

```sql
-- Core config tables
CREATE TABLE IF NOT EXISTS app_config (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    template_id text,
    title text,
    description text,
    persona text,
    theme jsonb DEFAULT '{}'::jsonb,
    layout jsonb DEFAULT '[]'::jsonb,
    layout_overrides jsonb DEFAULT '{}'::jsonb,
    kpi_config jsonb DEFAULT '[]'::jsonb,
    chart_config jsonb DEFAULT '[]'::jsonb,
    context_panel_config jsonb DEFAULT '{}'::jsonb,
    quick_actions jsonb DEFAULT '[]'::jsonb,
    form_config jsonb DEFAULT '{}'::jsonb,
    created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS agent_config (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    system_prompt text,
    persona text,
    action_label text DEFAULT 'Generate Analysis',
    tools jsonb DEFAULT '[]'::jsonb,
    source_tables jsonb DEFAULT '[]'::jsonb,
    model text DEFAULT 'claude-sonnet-4-20250514',
    temperature numeric DEFAULT 0.3,
    extraction_schema jsonb DEFAULT '{}'::jsonb,
    validation_rules jsonb DEFAULT '{}'::jsonb,
    output_sections jsonb DEFAULT '{}'::jsonb,
    pipeline_config jsonb DEFAULT '{}'::jsonb,
    pipeline_prompts jsonb DEFAULT '{}'::jsonb,
    workflow_config jsonb DEFAULT '{}'::jsonb,
    created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS dashboard_updates (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    component_id text,
    data jsonb DEFAULT '{}'::jsonb,
    created_at timestamptz DEFAULT now()
);

-- Enable RLS with public read/write (for demo purposes)
ALTER TABLE app_config ENABLE ROW LEVEL SECURITY;
CREATE POLICY "anon_all_app_config" ON app_config FOR ALL TO anon USING (true) WITH CHECK (true);

ALTER TABLE agent_config ENABLE ROW LEVEL SECURITY;
CREATE POLICY "anon_all_agent_config" ON agent_config FOR ALL TO anon USING (true) WITH CHECK (true);

ALTER TABLE dashboard_updates ENABLE ROW LEVEL SECURITY;
CREATE POLICY "anon_all_dashboard_updates" ON dashboard_updates FOR ALL TO anon USING (true) WITH CHECK (true);

-- Enable realtime for dashboard_updates
ALTER PUBLICATION supabase_realtime ADD TABLE dashboard_updates;
```

> The meta-agent creates all domain-specific tables (e.g. `claims`, `market_data`) automatically on each run. You only need to create these three core tables once.

## 3. Configure environment variables

### Meta-agent (`interview-app/.env`)

```bash
cp interview-app/.env.example interview-app/.env
cp interview-app/.env.local.example interview-app/.env.local
```

Fill in `interview-app/.env`:

```env
# Required
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SECRET_KEY=eyJ...                    # Settings → API → service_role key
ANTHROPIC_API_KEY=sk-ant-...
DATABASE_URL=postgresql://postgres:...         # Settings → Database → Connection string (URI)

# Optional — enables extra features
VOYAGE_API_KEY=pa-...                          # Vector embeddings (voyageai.com)
UNSPLASH_ACCESS_KEY=...                        # Header images (unsplash.com/developers)
ALPHA_VANTAGE_API_KEY=...                      # Stock quotes (alphavantage.co, free tier)
```

### Frontend (`interview-app/.env.local`)

Fill in `interview-app/.env.local`:

```env
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=eyJ...    # Settings → API → anon/public key
SUPABASE_SECRET_KEY=eyJ...                     # Same service_role key as above
ANTHROPIC_API_KEY=sk-ant-...
VOYAGE_API_KEY=pa-...                          # Optional, same as above
```

### Where to find Supabase credentials

| Credential | Location in Supabase dashboard |
|---|---|
| `SUPABASE_URL` | Settings → API → Project URL |
| `SUPABASE_SECRET_KEY` | Settings → API → `service_role` key (secret) |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Settings → API → `anon` / `public` key |
| `DATABASE_URL` | Settings → Database → Connection string → URI |

## 4. Install dependencies

```bash
# Python (meta-agent)
uv sync

# Node.js (frontend)
cd interview-app
pnpm install
cd ..
```

## 5. Run the meta-agent

```bash
uv run python meta_agent.py "Claims processing for a health insurer"
```

This will:
1. Ask Claude to design the app (layout, tables, rules, pipeline)
2. Create database tables and seed sample data
3. Discover free APIs for live data — **you'll be prompted to review/edit before fetching**
4. Run validation rules and compute scores
5. Write config to Supabase

The plan is saved to `plans/` as both `.json` (machine-readable) and `.md` (human-readable).

## 6. Start the frontend

```bash
cd interview-app
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000).

---

## Replaying and editing

### Re-run from a saved plan (skip Claude classification)

```bash
uv run python meta_agent.py --from-plan plans/claims_processing.json
```

### Edit the plan in markdown, then re-run

Edit `plans/claims_processing.md` in your editor (change rules, thresholds, KPIs, etc.), then:

```bash
uv run python meta_agent.py --from-md plans/claims_processing.md
```

### Re-run with edited data sources

After a run, datasources are saved to `plans/*_datasources.json`. Edit them (swap URLs, change target tables), then:

```bash
uv run python meta_agent.py --from-plan plans/claims_processing.json --from-datasources plans/claims_processing_datasources.json
```

---

## Realtime data sources

On fresh runs, the meta-agent asks Claude to discover free public APIs relevant to the scenario. Before fetching, you may see an interactive prompt:

```
  ── Realtime Data Sources ──────────────────────────────
  Found 2 potential data source(s):

  [1] stock_quotes → table 'market_data'
      Real-time stock prices for portfolio holdings
      • https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum&vs_currencies=usd

  [2] exchange_rates → table 'currencies'
      Live forex rates vs USD
      • https://open.er-api.com/v6/latest/USD

  Options:
    enter     — accept and fetch all sources above
    s         — skip realtime data (keep synthetic)
    e         — edit: open datasources JSON in $EDITOR, then continue
    a <url>   — add a URL to a source
    r <num>   — remove source by number
  ──────────────────────────────────────────────────────
```

URLs are fetched through a trusted allowlist. Claude then parses the raw JSON responses into rows matching your table schema.

If no relevant API exists for a scenario (e.g. "ER medical clearance"), the node skips and synthetic data is kept.

---

## Project structure

```
perficient/
├── meta_agent.py          # LangGraph orchestrator — the entire backend
├── plans/                  # Saved plans, datasources (generated)
│
├── interview-app/          # Next.js frontend
│   ├── src/
│   │   ├── app/
│   │   │   ├── page.tsx              # Main app shell (reads layout from Supabase)
│   │   │   └── api/                  # API routes
│   │   │       ├── chat/route.ts     # AI chat (streaming)
│   │   │       ├── analyze/route.ts  # Document analysis pipeline
│   │   │       ├── submit/route.ts   # Form submission + pipeline
│   │   │       ├── research/route.ts # Research report generation
│   │   │       └── ...
│   │   ├── components/
│   │   │   ├── panels/               # Layout panels (dashboard, workflow, form, ...)
│   │   │   └── sections/             # Pipeline output renderers (score, checklist, ...)
│   │   └── lib/
│   │       ├── types.ts              # Shared TypeScript types
│   │       └── supabase.ts           # Supabase client
│   ├── .env                          # Meta-agent env vars (not committed)
│   └── .env.local                    # Frontend env vars (not committed)
│
└── pyproject.toml          # Python dependencies (uv)
```

---

## Environment variable reference

| Variable | Required | Used by | Purpose |
|---|---|---|---|
| `SUPABASE_URL` | Yes | Both | Supabase project URL |
| `SUPABASE_SECRET_KEY` | Yes | Both | Service role key (full access) |
| `DATABASE_URL` | Yes | Meta-agent | Direct Postgres connection for DDL |
| `ANTHROPIC_API_KEY` | Yes | Both | Claude API calls |
| `NEXT_PUBLIC_SUPABASE_URL` | Yes | Frontend | Public Supabase URL (client-side) |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Yes | Frontend | Anon key (client-side) |
| `VOYAGE_API_KEY` | No | Both | Vector embeddings for similarity search |
| `UNSPLASH_ACCESS_KEY` | No | Meta-agent | Header images for the dashboard |
| `ALPHA_VANTAGE_API_KEY` | No | Meta-agent | Stock price data (free: 25 calls/day) |
| `OPENWEATHER_API_KEY` | No | Meta-agent | Weather data for relevant scenarios |
| `OMDB_API_KEY` | No | Meta-agent | Movie/TV data |
| `NASA_API_KEY` | No | Meta-agent | NASA open data |
