"use client";

import { useChat } from "@ai-sdk/react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { Send } from "lucide-react";
import { useState, useEffect, useRef, useSyncExternalStore, useCallback } from "react";
import ReactMarkdown from "react-markdown";
import { getFocusContext, subscribeFocusContext, type FocusContext } from "@/lib/focus-context";

function useFocusContext() {
  return useSyncExternalStore(subscribeFocusContext, getFocusContext, () => null);
}

function buildFocusPrefix(focus: FocusContext): string {
  const fields = Object.entries(focus.record)
    .filter(([k]) => !["id", "created_at", "embedding"].includes(k))
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");

  let prefix = `[Context: The user is currently viewing a record from "${focus.tableName}":\n${fields}`;
  if (focus.analysisSummary) {
    prefix += `\n\nPrior analysis summary:\n${focus.analysisSummary}`;
  }
  prefix += `\n\nAnswer their question in the context of THIS record unless they clearly ask about something else.]\n\n`;
  return prefix;
}

export function ChatPanel({
  persona,
  quickActions,
}: {
  persona?: string;
  quickActions?: { label: string; prompt: string }[];
}) {
  const focus = useFocusContext();
  const focusRef = useRef(focus);
  focusRef.current = focus;

  const { messages, sendMessage, status } = useChat();
  const [input, setInput] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const isLoading = status === "streaming" || status === "submitted";

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  const handleSend = useCallback((text: string) => {
    if (!text.trim() || isLoading) return;
    // Prepend focus context to the user's message so the API has it
    const currentFocus = focusRef.current;
    const enrichedText = currentFocus
      ? buildFocusPrefix(currentFocus) + text.trim()
      : text.trim();
    sendMessage({ text: enrichedText });
    setInput("");
  }, [isLoading, sendMessage]);

  // Build a display label for focus context
  const isUUID = (s: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-/.test(s);
  const focusLabel = focus
    ? Object.entries(focus.record).find(([k, v]) => !["id", "created_at", "stage", "embedding", "notes"].includes(k) && typeof v === "string" && v.length > 2 && v.length < 80 && !isUUID(v))?.[1] as string | undefined
    : null;

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2.5 border-b border-border/30 px-5 py-4">
        <div className="h-7 w-7 rounded-full bg-gradient-to-br from-primary to-primary/60 flex items-center justify-center shadow-sm shadow-primary/15">
          <span className="text-primary-foreground text-[9px] font-bold">AI</span>
        </div>
        <div className="flex-1 min-w-0">
          <span className="text-[13px] font-semibold">{persona || "AI Assistant"}</span>
          {focusLabel && (
            <p className="text-[10px] text-primary/70 truncate">
              Focused on: {focusLabel}
            </p>
          )}
        </div>
      </div>
      <ScrollArea className="flex-1 p-5 custom-scroll" ref={scrollRef}>
        <div className="flex flex-col gap-3.5">
          {messages.length === 0 && (
            <div className="flex flex-col items-center gap-4 py-12 text-center">
              <div className="h-12 w-12 rounded-full bg-gradient-to-br from-primary/15 to-primary/5 flex items-center justify-center">
                <span className="text-primary text-sm font-bold">AI</span>
              </div>
              <div>
                <p className="text-sm font-medium mb-1">
                  {persona || "AI Assistant"}
                </p>
                <p className="text-xs text-muted-foreground/60 leading-relaxed max-w-[260px]">
                  {focus
                    ? `Ready to answer questions about ${focusLabel || "the selected record"}. Try asking about specific details, risks, or recommendations.`
                    : "I have access to all the data in this system. Ask me about trends, specific records, comparisons, or anything else."}
                </p>
              </div>
            </div>
          )}
          {messages.map((msg) => {
            // Strip the focus context prefix from displayed user messages
            let displayParts = msg.parts;
            if (msg.role === "user" && displayParts) {
              displayParts = displayParts.map((part) => {
                if (part.type === "text" && part.text.startsWith("[Context:")) {
                  const end = part.text.indexOf("]\n\n");
                  return end >= 0 ? { ...part, text: part.text.slice(end + 3) } : part;
                }
                return part;
              });
            }

            return (
              <div
                key={msg.id}
                className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
              >
                <div
                  className={`max-w-[85%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${
                    msg.role === "user"
                      ? "bg-primary text-primary-foreground rounded-br-lg shadow-sm shadow-primary/20 whitespace-pre-wrap"
                      : "bg-muted/80 rounded-bl-lg prose prose-sm max-w-none prose-p:my-1 prose-headings:my-2 prose-ul:my-1 prose-ol:my-1 prose-li:my-0 prose-strong:text-foreground"
                  }`}
                >
                  {displayParts && displayParts.length > 0
                    ? displayParts.map((part, i) =>
                        part.type === "text" ? (
                          msg.role === "assistant"
                            ? <ReactMarkdown key={i}>{part.text}</ReactMarkdown>
                            : <span key={i}>{part.text}</span>
                        ) : null
                      )
                    : isLoading && msg.role === "assistant"
                      ? "Thinking..."
                      : ""}
                </div>
              </div>
            );
          })}
        </div>
      </ScrollArea>

      {quickActions && quickActions.length > 0 && messages.length === 0 && (
        <div className="grid grid-cols-2 gap-2 px-5 pb-3">
          {quickActions.map((action, i) => {
            const colors = [
              "bg-blue-500/10 text-blue-700 dark:text-blue-400",
              "bg-purple-500/10 text-purple-700 dark:text-purple-400",
              "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
              "bg-amber-500/10 text-amber-700 dark:text-amber-400",
            ];
            return (
              <button
                key={action.label}
                onClick={() => handleSend(action.prompt)}
                className={`flex items-center gap-2.5 rounded-xl px-3 py-2.5 text-left transition-all duration-200 hover:scale-[1.02] active:scale-[0.98] ${colors[i % colors.length]}`}
              >
                <span className="text-xs font-medium leading-tight">{action.label}</span>
              </button>
            );
          })}
        </div>
      )}

      <form
        className="flex gap-2.5 border-t border-border/30 p-4"
        onSubmit={(e) => {
          e.preventDefault();
          handleSend(input);
        }}
      >
        <Input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={focus ? `Ask about ${focusLabel || "this record"}...` : "Type a message..."}
          disabled={isLoading}
          className="h-10 text-sm rounded-xl bg-muted/50 border-border/40"
        />
        <Button type="submit" size="sm" disabled={isLoading || !input.trim()} className="h-10 w-10 p-0 shrink-0 rounded-xl">
          <Send className="h-4 w-4" />
        </Button>
      </form>
    </div>
  );
}
