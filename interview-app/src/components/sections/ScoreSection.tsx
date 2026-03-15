import type { OutputSection, ScoreData } from "@/lib/types";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export function ScoreSection({ section }: { section: OutputSection }) {
  const { score, max, label } = section.data as ScoreData;
  const pct = max > 0 ? (score / max) * 100 : 0;

  const color =
    pct >= 80 ? "text-emerald-600" : pct >= 50 ? "text-amber-600" : "text-red-500";

  const bgColor =
    pct >= 80 ? "bg-emerald-500" : pct >= 50 ? "bg-amber-500" : "bg-red-500";

  const bgLight =
    pct >= 80 ? "bg-emerald-50" : pct >= 50 ? "bg-amber-50" : "bg-red-50";

  const ringColor =
    pct >= 80 ? "ring-emerald-200/60" : pct >= 50 ? "ring-amber-200/60" : "ring-red-200/60";

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-semibold">{section.title}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="flex items-center gap-6">
          {/* Score circle */}
          <div className={`flex h-20 w-20 shrink-0 items-center justify-center rounded-full ${bgLight} ring-2 ${ringColor}`}>
            <div className="text-center">
              <span className={`text-2xl font-bold ${color}`}>{score}</span>
              <span className="text-[10px] text-muted-foreground/60 block font-medium">/ {max}</span>
            </div>
          </div>
          <div className="flex-1">
            <p className={`text-sm font-semibold ${color}`}>
              {pct >= 80 ? "Good" : pct >= 50 ? "Needs Review" : "High Risk"}
            </p>
            {label && <p className="text-xs text-muted-foreground/70 mt-0.5 leading-relaxed">{label}</p>}
            <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-muted/70">
              <div
                className={`h-full rounded-full transition-all duration-700 ease-out ${bgColor}`}
                style={{ width: `${pct}%` }}
              />
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
