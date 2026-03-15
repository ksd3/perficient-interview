import type { OutputSection, KVPairsData } from "@/lib/types";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

export function KVPairsSection({ section }: { section: OutputSection }) {
  const { pairs } = section.data as KVPairsData;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-semibold">{section.title}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid gap-3">
          {Object.entries(pairs).map(([key, value]) => (
            <div key={key} className="flex flex-col gap-1">
              <span className="text-[11px] font-semibold text-muted-foreground/70 uppercase tracking-wider">
                {key.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())}
              </span>
              <span className="text-sm">
                {key === "status" ? (
                  <Badge variant={value === "approved" ? "default" : "destructive"}>
                    {value}
                  </Badge>
                ) : (
                  value
                )}
              </span>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
