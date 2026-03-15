import type { OutputSection, ChecklistData } from "@/lib/types";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export function ChecklistSection({ section }: { section: OutputSection }) {
  const { items } = section.data as ChecklistData;
  const passCount = items.filter((i) => i.passed).length;

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="text-sm font-semibold">{section.title}</CardTitle>
        <span className="text-xs text-muted-foreground/70 font-medium">
          {passCount}/{items.length} passed
        </span>
      </CardHeader>
      <CardContent>
        <div className="flex flex-col gap-1.5">
          {items.map((item) => (
            <div
              key={item.id}
              className={`flex items-start gap-3 rounded-xl px-3.5 py-2.5 transition-colors ${
                item.passed ? "bg-emerald-50/60" : "bg-red-50/60"
              }`}
            >
              <span
                className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-xs font-bold ${
                  item.passed
                    ? "bg-emerald-100 text-emerald-600"
                    : "bg-red-100 text-red-500"
                }`}
              >
                {item.passed ? "\u2713" : "\u2717"}
              </span>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">{item.label}</span>
                  {!item.passed && (
                    <span
                      className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
                        item.severity === "critical"
                          ? "bg-red-100/80 text-red-600"
                          : item.severity === "warning"
                            ? "bg-amber-100/80 text-amber-600"
                            : "bg-blue-100/80 text-blue-600"
                      }`}
                    >
                      {item.severity}
                    </span>
                  )}
                </div>
                {item.message && (
                  <p className="text-xs text-muted-foreground/70 mt-0.5 leading-relaxed">{item.message}</p>
                )}
              </div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
