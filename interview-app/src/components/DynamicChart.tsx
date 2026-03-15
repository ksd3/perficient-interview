"use client";

import { useEffect, useState } from "react";
import {
  BarChart,
  Bar,
  LineChart,
  Line,
  PieChart,
  Pie,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Cell,
  ResponsiveContainer,
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { createClient } from "@/lib/supabase";
import type { ChartConfigItem } from "@/lib/types";

// Apple-inspired vibrant chart palette
const COLORS = [
  "#007AFF", // blue
  "#AF52DE", // purple
  "#FF9500", // orange
  "#34C759", // green
  "#FF2D55", // pink
];

export function DynamicChart({ config, refreshKey = 0 }: { config: ChartConfigItem; refreshKey?: number }) {
  const [data, setData] = useState<Record<string, unknown>[]>([]);
  const supabase = createClient();

  useEffect(() => {
    async function fetch() {
      const { data: rows } = await supabase
        .from(config.table)
        .select("*")
        .limit(100);
      if (rows) setData(rows as unknown as Record<string, unknown>[]);
    }
    fetch();
  }, [config, refreshKey]);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-semibold">{config.title}</CardTitle>
      </CardHeader>
      <CardContent>
        <ResponsiveContainer width="100%" height={220} minWidth={200}>
          {config.type === "bar" ? (
            <BarChart data={data}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey={config.x_field} fontSize={12} />
              <YAxis fontSize={12} />
              <Tooltip />
              <Bar dataKey={config.y_field} fill={config.color || COLORS[0]} radius={[4, 4, 0, 0]} />
            </BarChart>
          ) : config.type === "line" ? (
            <LineChart data={data}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey={config.x_field} fontSize={12} />
              <YAxis fontSize={12} />
              <Tooltip />
              <Line type="monotone" dataKey={config.y_field} stroke={config.color || COLORS[0]} strokeWidth={2} />
            </LineChart>
          ) : config.type === "area" ? (
            <AreaChart data={data}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey={config.x_field} fontSize={12} />
              <YAxis fontSize={12} />
              <Tooltip />
              <Area type="monotone" dataKey={config.y_field} fill={config.color || COLORS[0]} stroke={config.color || COLORS[0]} fillOpacity={0.3} />
            </AreaChart>
          ) : (
            <PieChart>
              <Tooltip />
              <Pie data={data} dataKey={config.y_field} nameKey={config.x_field} cx="50%" cy="50%" outerRadius={80}>
                {data.map((_, i) => (
                  <Cell key={i} fill={COLORS[i % COLORS.length]} />
                ))}
              </Pie>
            </PieChart>
          )}
        </ResponsiveContainer>
      </CardContent>
    </Card>
  );
}
