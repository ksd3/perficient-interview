/**
 * Lightweight global store for the currently focused record.
 * DynamicTable writes to this when a record is expanded/analyzed.
 * ChatPanel reads it to provide context-aware responses.
 */

export interface FocusContext {
  tableName: string;
  record: Record<string, unknown>;
  relatedData?: Record<string, Record<string, unknown>[]>;
  analysisSummary?: string;
}

let current: FocusContext | null = null;
const listeners = new Set<() => void>();

export function setFocusContext(ctx: FocusContext | null) {
  current = ctx;
  listeners.forEach((fn) => fn());
}

export function getFocusContext(): FocusContext | null {
  return current;
}

export function subscribeFocusContext(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
