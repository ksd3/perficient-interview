// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

export type PanelType =
  | "form"
  | "document_upload"
  | "pipeline_results"
  | "workflow"
  | "dashboard"
  | "research"
  | "chat_sidebar";

// ---------------------------------------------------------------------------
// KPI / Chart / Table (existing, unchanged)
// ---------------------------------------------------------------------------

export interface KPIConfig {
  label: string;
  table: string;
  filter?: string;
  aggregate: "count" | "sum" | "avg" | "count_ratio";
  field?: string;
  format?: "number" | "currency" | "percent";
}

export interface ChartConfigItem {
  title: string;
  type: "bar" | "line" | "pie" | "area";
  table: string;
  x_field: string;
  y_field: string;
  color?: string;
}

export interface TableConfig {
  source_table: string;
  columns: string[];
}

// ---------------------------------------------------------------------------
// Form Config (app_config.form_config)
// ---------------------------------------------------------------------------

export type FormFieldType =
  | "text"
  | "number"
  | "date"
  | "select"
  | "checkbox"
  | "textarea"
  | "email"
  | "phone";

export interface FormField {
  name: string;
  label: string;
  type: FormFieldType;
  required?: boolean;
  options?: string[]; // for select
  placeholder?: string;
}

export interface FormSection {
  label: string;
  fields: FormField[];
}

export interface FormConfig {
  title: string;
  sections: FormSection[];
  target_table: string;
  post_submit_pipeline?: boolean;
}

// ---------------------------------------------------------------------------
// Pipeline Config (agent_config.pipeline_config)
// ---------------------------------------------------------------------------

export interface ExtractionField {
  name: string;
  type: "string" | "number" | "boolean" | "enum" | "date";
  description: string;
  required?: boolean;
  options?: string[]; // for enum
}

export interface ExtractionSchema {
  fields: ExtractionField[];
}

export interface ValidationRule {
  id: string;
  label: string;
  expression: string; // e.g. "loan_amount / property_value"
  operator: "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "in" | "exists" | "is_true" | "is_false";
  threshold: number | string | boolean;
  severity: "critical" | "warning" | "info";
  fail_message: string; // supports {{value}} interpolation
  category?: string; // e.g. "fraud", "complexity", "compliance" — used for multi-score pipelines
}

export interface ValidationRulesConfig {
  rules: ValidationRule[];
}

export interface PipelineStepConfig {
  id: string;
  type: "llm_extract" | "rule_engine" | "compute_score" | "llm_summarize" | "llm_generate" | "web_search" | "vector_search" | "record_match" | "llm_custom";
  config?: Record<string, unknown>;
}

export interface PipelineConfig {
  steps: PipelineStepConfig[];
}

// ---------------------------------------------------------------------------
// Output Sections (agent_config.output_sections + pipeline output)
// ---------------------------------------------------------------------------

export interface OutputSectionDef {
  id: string;
  type: "field_table" | "checklist" | "score" | "text" | "list" | "kv_pairs" | "document" | "web_search_results" | "record_match";
  title: string;
  source: string; // e.g. "extraction", "validation", "score", "summary"
}

export interface OutputSectionsConfig {
  sections: OutputSectionDef[];
}

// Runtime section data returned by the pipeline
export interface OutputSection {
  id: string;
  type: "field_table" | "checklist" | "score" | "text" | "list" | "kv_pairs" | "document" | "web_search_results" | "record_match";
  title: string;
  data: unknown; // typed per renderer
}

// Section-specific data shapes
export interface FieldTableData {
  fields: { name: string; label: string; value: unknown; flagged?: boolean }[];
}

export interface ChecklistData {
  items: {
    id: string;
    label: string;
    passed: boolean;
    severity: "critical" | "warning" | "info";
    message?: string;
    value?: number | string;
  }[];
}

export interface ScoreData {
  score: number;
  max: number;
  label?: string;
}

export interface TextData {
  content: string;
}

export interface ListData {
  items: string[];
}

export interface KVPairsData {
  pairs: Record<string, string>;
}

export interface DocumentData {
  content: string;
  format?: "markdown" | "text";
}

export interface RecordMatchItem {
  record_id: string;
  record_label: string;
  match_score: number;
  criteria_met: string[];
  criteria_unmet: string[];
  criteria_unclear: string[];
}

export interface RecordMatchData {
  matches: RecordMatchItem[];
}

// ---------------------------------------------------------------------------
// Workflow Config (agent_config.workflow_config)
// ---------------------------------------------------------------------------

export interface WorkflowAction {
  id: string;
  label: string;
  next_stage: string;
  style?: "default" | "destructive";
  confirm?: boolean;
  side_effect?: {
    type: "set_fields" | "run_pipeline" | "webhook";
    fields?: Record<string, unknown>;       // for set_fields: {priority: "high", assigned_to: "Dr. Smith"}
    pipeline_steps?: string[];               // for run_pipeline: ["extract", "summarize"]
    webhook_url?: string;                    // for webhook: URL to POST to
    webhook_body?: Record<string, unknown>;  // for webhook: additional body fields
  };
}

export interface WorkflowStage {
  id: string;
  label: string;
  actions: WorkflowAction[];
  terminal?: boolean;
}

export interface WorkflowConfig {
  stages: WorkflowStage[];
  initial_stage: string;
  item_table: string;
}

// ---------------------------------------------------------------------------
// App Config (Supabase: app_config table)
// ---------------------------------------------------------------------------

export interface AppConfig {
  id: string;
  title: string;
  description?: string;
  persona?: string;
  theme: Record<string, string>;
  layout: PanelType[];
  kpi_config: KPIConfig[];
  chart_config: ChartConfigItem[];
  quick_actions: { label: string; prompt: string }[];
  form_config: FormConfig | null;
  // kept for backwards compat during migration
  template_id?: string;
  layout_overrides?: Record<string, unknown>;
  context_panel_config?: Record<string, unknown>;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Agent Config (Supabase: agent_config table)
// ---------------------------------------------------------------------------

export interface PipelinePrompts {
  extract_system?: string;
  summarize_system?: string;
  generate_system?: string;
}

export interface AgentConfig {
  id: string;
  system_prompt: string;
  persona?: string;
  tools: Record<string, unknown>[];
  source_tables: string[];
  model: string;
  temperature: number;
  extraction_schema: ExtractionSchema | null;
  validation_rules: ValidationRulesConfig | null;
  output_sections: OutputSectionsConfig | null;
  pipeline_config: PipelineConfig | null;
  pipeline_prompts?: PipelinePrompts | null;
  workflow_config: WorkflowConfig | null;
  created_at: string;
}

// ---------------------------------------------------------------------------
// API Response Types
// ---------------------------------------------------------------------------

export interface AnalyzeResponse {
  sections: OutputSection[];
  metadata: {
    pipeline_steps: string[];
    duration_ms: number;
  };
}

export interface SubmitResponse {
  success: boolean;
  item_id?: string;
  pipeline_results?: AnalyzeResponse;
  error?: string;
}

export interface ActionResponse {
  success: boolean;
  new_stage?: string;
  error?: string;
}
