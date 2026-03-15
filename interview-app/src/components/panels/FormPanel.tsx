"use client";

import { useState } from "react";
import type { AppConfig, FormConfig, FormField, OutputSection } from "@/lib/types";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { SectionRenderer } from "@/components/sections/SectionRenderer";
import { ProcessingIndicator } from "@/components/ui/processing-indicator";

function FieldInput({
  field,
  value,
  onChange,
  error,
}: {
  field: FormField;
  value: string;
  onChange: (v: string) => void;
  error?: string;
}) {
  const baseClass =
    "w-full rounded-xl border border-border bg-card px-4 py-3 text-[15px] outline-none transition-all duration-200 shadow-sm focus-visible:border-primary/50 focus-visible:ring-3 focus-visible:ring-primary/15 placeholder:text-muted-foreground/40";

  switch (field.type) {
    case "textarea":
      return (
        <div>
          <textarea
            className={`${baseClass} min-h-[100px]`}
            placeholder={field.placeholder}
            value={value}
            onChange={(e) => onChange(e.target.value)}
          />
          {error && <p className="mt-1 text-xs text-red-500">{error}</p>}
        </div>
      );
    case "select":
      return (
        <div>
          <select
            className={baseClass}
            value={value}
            onChange={(e) => onChange(e.target.value)}
          >
            <option value="">Select...</option>
            {field.options?.map((opt) => (
              <option key={opt} value={opt}>
                {opt}
              </option>
            ))}
          </select>
          {error && <p className="mt-1 text-xs text-red-500">{error}</p>}
        </div>
      );
    case "checkbox":
      return (
        <div>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={value === "true"}
              onChange={(e) => onChange(String(e.target.checked))}
              className="h-4 w-4 rounded border-input"
            />
            {field.label}
          </label>
          {error && <p className="mt-1 text-xs text-red-500">{error}</p>}
        </div>
      );
    default: {
      const inputType =
        field.type === "number" ? "number" :
        field.type === "date" ? "date" :
        field.type === "email" ? "email" :
        field.type === "phone" ? "tel" :
        "text";
      return (
        <div>
          <Input
            type={inputType}
            placeholder={field.placeholder}
            value={value}
            onChange={(e) => onChange(e.target.value)}
          />
          {error && <p className="mt-1 text-xs text-red-500">{error}</p>}
        </div>
      );
    }
  }
}

function validate(formConfig: FormConfig, values: Record<string, string>): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const section of formConfig.sections) {
    for (const field of section.fields) {
      const v = values[field.name] || "";
      if (field.required && !v.trim()) {
        errors[field.name] = "Required";
      } else if (field.type === "email" && v && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) {
        errors[field.name] = "Invalid email";
      } else if (field.type === "number" && v && isNaN(Number(v))) {
        errors[field.name] = "Must be a number";
      }
    }
  }
  return errors;
}

export function FormPanel({ config, onResults }: { config: AppConfig; onResults?: (sections: OutputSection[]) => void }) {
  const formConfig = config.form_config;
  const [values, setValues] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [pipelineResults, setPipelineResults] = useState<OutputSection[] | null>(null);

  if (!formConfig) return null;

  function setValue(name: string, value: string) {
    setValues((prev) => ({ ...prev, [name]: value }));
    // Clear error on change
    if (errors[name]) {
      setErrors((prev) => {
        const next = { ...prev };
        delete next[name];
        return next;
      });
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!formConfig) return;

    const errs = validate(formConfig, values);
    if (Object.keys(errs).length > 0) {
      setErrors(errs);
      return;
    }

    setSubmitting(true);
    setSubmitError(null);

    try {
      const res = await fetch("/api/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ data: values }),
      });

      const result = await res.json();

      if (!res.ok || !result.success) {
        setSubmitError(result.error || "Submission failed");
      } else {
        setSubmitted(true);
        if (result.pipeline_results?.sections) {
          setPipelineResults(result.pipeline_results.sections);
          onResults?.(result.pipeline_results.sections);
        }
      }
    } catch {
      setSubmitError("Submission failed. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  function resetForm() {
    setValues({});
    setErrors({});
    setSubmitted(false);
    setSubmitError(null);
    setPipelineResults(null);
  }

  if (submitted) {
    return (
      <div className="flex flex-col gap-5">
        <Card>
          <CardContent className="flex flex-col items-center gap-4 pt-8 pb-8">
            <div className="h-12 w-12 rounded-full bg-emerald-50 flex items-center justify-center">
              <span className="text-emerald-600 text-lg font-bold">{"\u2713"}</span>
            </div>
            <div className="text-center">
              <p className="text-sm font-semibold">Submitted</p>
              <p className="text-sm text-muted-foreground/70 mt-1">
                {formConfig.title} submitted successfully.
              </p>
            </div>
            <Button variant="outline" size="sm" onClick={resetForm}>
              Submit Another
            </Button>
          </CardContent>
        </Card>
        {pipelineResults && <SectionRenderer sections={pipelineResults} />}
      </div>
    );
  }

  const sectionColors = [
    "from-blue-500/10 to-blue-500/0",
    "from-purple-500/10 to-purple-500/0",
    "from-emerald-500/10 to-emerald-500/0",
    "from-amber-500/10 to-amber-500/0",
  ];

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-6">
      {/* Form header */}
      <div className="flex items-center gap-4">
        <div className="h-12 w-12 rounded-2xl bg-gradient-to-br from-primary to-primary/60 flex items-center justify-center shadow-md shadow-primary/20 shrink-0">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <path d="M9 12h6" /><path d="M9 16h6" /><path d="M9 8h6" />
          </svg>
        </div>
        <div>
          <h2 className="text-lg font-bold tracking-tight">{formConfig.title}</h2>
          {config.description && (
            <p className="text-sm text-muted-foreground mt-0.5">{config.description}</p>
          )}
        </div>
      </div>

      {formConfig.sections.map((section, si) => (
        <Card key={section.label}>
          <CardHeader className={`bg-gradient-to-r ${sectionColors[si % sectionColors.length]} rounded-t-2xl`}>
            <div className="flex items-center gap-3">
              <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10 text-primary text-sm font-bold shrink-0">
                {si + 1}
              </span>
              <CardTitle>{section.label}</CardTitle>
            </div>
          </CardHeader>
          <CardContent>
            <div className="grid gap-5 sm:grid-cols-2">
              {section.fields.map((field) => (
                <div
                  key={field.name}
                  className={field.type === "textarea" ? "sm:col-span-2" : ""}
                >
                  {field.type !== "checkbox" && (
                    <label className="mb-2 block text-[12px] font-semibold text-muted-foreground/80 uppercase tracking-wider">
                      {field.label}
                      {field.required && <span className="text-red-400"> *</span>}
                    </label>
                  )}
                  <FieldInput
                    field={field}
                    value={values[field.name] || ""}
                    onChange={(v) => setValue(field.name, v)}
                    error={errors[field.name]}
                  />
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      ))}

      {submitError && (
        <p className="text-sm text-red-500">{submitError}</p>
      )}

      <Button type="submit" size="lg" disabled={submitting} className="w-full text-base py-3 h-12">
        {submitting ? "Submitting..." : "Submit"}
      </Button>
      {submitting && <ProcessingIndicator variant="submit" />}
    </form>
  );
}
