import { Button } from "@cloudflare/kumo/components/button";

export const RANGES = ["24h", "7d", "30d"] as const;
export type Range = (typeof RANGES)[number];

/** A segmented control; each option is a `data-flightdeck` button named `<page>.<name>`. */
export function Segmented<T extends string>(props: {
  label: string;
  page: string;
  name: string;
  options: readonly { id: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: a fieldset would add a visible border and legend.
    <div role="group" aria-label={props.label} className="fd-segmented">
      {props.options.map((o) => (
        <Button
          key={o.id}
          size="sm"
          variant={o.id === props.value ? "primary" : "ghost"}
          aria-pressed={o.id === props.value}
          data-flightdeck={`${props.page}.${props.name}`}
          {...{ [`data-flightdeck-${props.name}`]: o.id }}
          onClick={() => o.id !== props.value && props.onChange(o.id)}
        >
          {o.label}
        </Button>
      ))}
    </div>
  );
}

const RANGE_OPTIONS = RANGES.map((r) => ({ id: r, label: r }));

/** Time-range control. */
export function RangeFilter(props: { page: string; value: Range; onChange: (r: Range) => void }) {
  return (
    <Segmented
      label="Time range"
      page={props.page}
      name="range"
      options={RANGE_OPTIONS}
      value={props.value}
      onChange={props.onChange}
    />
  );
}
