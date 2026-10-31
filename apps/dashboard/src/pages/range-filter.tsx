import { Button } from "@cloudflare/kumo/components/button";
import { useState } from "react";

export const RANGES = ["24h", "7d", "30d"] as const;
export type Range = (typeof RANGES)[number];

/** Time-range control. A placeholder until trends queries (A4) consume the value. */
export function RangeFilter({ page }: { page: string }) {
  const [range, setRange] = useState<Range>("24h");
  return (
    // biome-ignore lint/a11y/useSemanticElements: a fieldset would add a visible border and legend.
    <div role="group" aria-label="Time range" className="fd-segmented">
      {RANGES.map((r) => (
        <Button
          key={r}
          size="sm"
          variant={r === range ? "primary" : "ghost"}
          aria-pressed={r === range}
          data-flightdeck={`${page}.range`}
          data-flightdeck-range={r}
          onClick={() => setRange(r)}
        >
          {r}
        </Button>
      ))}
    </div>
  );
}
