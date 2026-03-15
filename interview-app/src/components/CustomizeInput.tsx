"use client";

import { useState } from "react";
import { Input } from "@/components/ui/input";

export function CustomizeInput() {
  const [value, setValue] = useState("");
  const [status, setStatus] = useState<"idle" | "loading" | "success" | "error">("idle");
  const [description, setDescription] = useState("");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!value.trim() || status === "loading") return;
    setStatus("loading");
    setDescription("");

    try {
      const res = await fetch("/api/customize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ instruction: value.trim() }),
      });
      const data = await res.json();
      if (res.ok && data.success) {
        setStatus("success");
        setDescription(data.description);
        setValue("");
        setTimeout(() => setStatus("idle"), 3000);
      } else {
        setStatus("error");
        setDescription(data.error || "Failed to apply change");
        setTimeout(() => { setStatus("idle"); setDescription(""); }, 4000);
      }
    } catch {
      setStatus("error");
      setDescription("Could not connect");
      setTimeout(() => { setStatus("idle"); setDescription(""); }, 4000);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-1.5">
      <div className="relative">
        <Input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={
            status === "loading" ? "Applying..." :
            status === "success" ? "Done!" :
            "Customize with AI..."
          }
          disabled={status === "loading"}
          className="h-8 text-xs rounded-lg bg-muted/30 border-border/40 pr-8"
        />
        {status === "loading" && (
          <div className="absolute right-2.5 top-1/2 -translate-y-1/2">
            <div className="h-3.5 w-3.5 rounded-full border-2 border-primary border-t-transparent animate-spin" />
          </div>
        )}
        {status === "success" && (
          <div className="absolute right-2.5 top-1/2 -translate-y-1/2 text-emerald-500 text-xs">
            {"\u2713"}
          </div>
        )}
      </div>
      {description && (
        <p className={`text-[10px] leading-tight px-1 ${status === "success" ? "text-emerald-600/80" : "text-red-500/80"}`}>{description}</p>
      )}
    </form>
  );
}
