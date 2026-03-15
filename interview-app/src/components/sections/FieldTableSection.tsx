import type { OutputSection, FieldTableData } from "@/lib/types";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export function FieldTableSection({ section }: { section: OutputSection }) {
  const { fields } = section.data as FieldTableData;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-semibold">{section.title}</CardTitle>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Field</TableHead>
              <TableHead>Value</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {fields.map((f) => (
              <TableRow key={f.name}>
                <TableCell className="font-medium text-muted-foreground">
                  {f.label}
                </TableCell>
                <TableCell>
                  <span className={f.flagged ? "text-red-500 font-medium" : ""}>
                    {f.value === null || f.value === undefined ? "—" : String(f.value)}
                  </span>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
