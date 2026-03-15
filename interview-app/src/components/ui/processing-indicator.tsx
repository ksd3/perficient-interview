"use client";

import { useState, useEffect } from "react";

const ANALYSIS_MESSAGES = [
  "Reading and extracting key data...",
  "Running automated checks...",
  "Evaluating against criteria...",
  "Cross-referencing records...",
  "Synthesizing findings...",
  "Preparing results...",
];

const SUBMIT_MESSAGES = [
  "Saving record...",
  "Running automated checks...",
  "Evaluating against criteria...",
  "Scoring assessment...",
  "Generating analysis...",
  "Finalizing results...",
];

export function ProcessingIndicator({
  variant = "analyze",
}: {
  variant?: "analyze" | "submit";
}) {
  const messages = variant === "submit" ? SUBMIT_MESSAGES : ANALYSIS_MESSAGES;
  const [index, setIndex] = useState(0);
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    const interval = setInterval(() => {
      setVisible(false);
      setTimeout(() => {
        setIndex((i) => (i + 1) % messages.length);
        setVisible(true);
      }, 250);
    }, 2400);
    return () => clearInterval(interval);
  }, [messages.length]);

  return (
    <div className="flex items-center gap-3 pt-2">
      <div className="flex gap-1.5">
        <span className="h-1.5 w-1.5 rounded-full bg-primary/70 animate-[pulse_1.2s_ease-in-out_infinite]" />
        <span className="h-1.5 w-1.5 rounded-full bg-primary/70 animate-[pulse_1.2s_ease-in-out_0.2s_infinite]" />
        <span className="h-1.5 w-1.5 rounded-full bg-primary/70 animate-[pulse_1.2s_ease-in-out_0.4s_infinite]" />
      </div>
      <span
        className={`text-xs text-muted-foreground/70 transition-opacity duration-300 ${
          visible ? "opacity-100" : "opacity-0"
        }`}
      >
        {messages[index]}
      </span>
    </div>
  );
}
