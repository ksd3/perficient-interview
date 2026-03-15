"use client";

import ReactMarkdown from "react-markdown";
import type { OutputSection, TextData } from "@/lib/types";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export function TextSection({ section }: { section: OutputSection }) {
  const { content } = section.data as TextData;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-semibold">{section.title}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="prose prose-sm max-w-none text-sm leading-relaxed prose-headings:font-semibold prose-headings:tracking-tight prose-p:text-foreground/85 prose-li:text-foreground/85 prose-strong:text-foreground prose-a:text-primary prose-hr:border-border/40">
          <ReactMarkdown>{content}</ReactMarkdown>
        </div>
      </CardContent>
    </Card>
  );
}
