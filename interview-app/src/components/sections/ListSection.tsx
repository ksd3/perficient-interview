import type { OutputSection, ListData } from "@/lib/types";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export function ListSection({ section }: { section: OutputSection }) {
  const { items } = section.data as ListData;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-semibold">{section.title}</CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="flex flex-col gap-2">
          {items.map((item, i) => (
            <li key={i} className="flex items-start gap-2.5 text-sm leading-relaxed">
              <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-primary/40" />
              <span className="text-foreground/85">{item}</span>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
