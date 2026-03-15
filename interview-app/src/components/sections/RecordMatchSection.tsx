import type { OutputSection, RecordMatchData } from "@/lib/types";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export function RecordMatchSection({ section }: { section: OutputSection }) {
  const { matches } = section.data as RecordMatchData;

  if (!matches || matches.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-semibold">{section.title}</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground/70">No matches found.</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-semibold">{section.title}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3.5">
        {matches.map((match, i) => (
          <div
            key={match.record_id || i}
            className="rounded-xl border border-border/30 p-4"
          >
            <div className="flex items-center justify-between mb-2.5">
              <span className="text-sm font-semibold">{match.record_label}</span>
              <span
                className={`rounded-full px-3 py-0.5 text-xs font-bold ${
                  match.match_score >= 70
                    ? "bg-emerald-50 text-emerald-600"
                    : match.match_score >= 40
                      ? "bg-amber-50 text-amber-600"
                      : "bg-red-50 text-red-500"
                }`}
              >
                {match.match_score}% match
              </span>
            </div>

            {/* Progress bar */}
            <div className="h-1.5 w-full rounded-full bg-muted/70 mb-3.5">
              <div
                className={`h-1.5 rounded-full transition-all duration-700 ease-out ${
                  match.match_score >= 70
                    ? "bg-emerald-500"
                    : match.match_score >= 40
                      ? "bg-amber-500"
                      : "bg-red-500"
                }`}
                style={{ width: `${match.match_score}%` }}
              />
            </div>

            <div className="flex flex-col gap-2 text-xs">
              {match.criteria_met.length > 0 && (
                <div className="flex gap-2.5">
                  <span className="shrink-0 text-emerald-600 font-semibold">Met:</span>
                  <span className="text-muted-foreground/70">{match.criteria_met.join(", ")}</span>
                </div>
              )}
              {match.criteria_unmet.length > 0 && (
                <div className="flex gap-2.5">
                  <span className="shrink-0 text-red-500 font-semibold">Unmet:</span>
                  <span className="text-muted-foreground/70">{match.criteria_unmet.join(", ")}</span>
                </div>
              )}
              {match.criteria_unclear.length > 0 && (
                <div className="flex gap-2.5">
                  <span className="shrink-0 text-amber-600 font-semibold">Confirm:</span>
                  <span className="text-muted-foreground/70">{match.criteria_unclear.join(", ")}</span>
                </div>
              )}
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
