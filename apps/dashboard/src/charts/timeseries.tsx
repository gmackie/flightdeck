import { ChartLegend, ChartPalette, TimeseriesChart } from "@cloudflare/kumo/components/chart";
import { BarChart, LineChart } from "echarts/charts";
import { AriaComponent, GridComponent, TooltipComponent } from "echarts/components";
import * as echarts from "echarts/core";
import { SVGRenderer } from "echarts/renderers";
import { useState } from "react";
import { useDarkMode } from "../theme";

// Only what the dashboard draws, rendered as SVG: crisp at any zoom, and a smaller chunk.
echarts.use([LineChart, BarChart, GridComponent, TooltipComponent, AriaComponent, SVGRenderer]);

export type ChartSeries = { name: string; label?: string; points: [number, number][] };

export type TimeseriesProps = {
  series: ChartSeries[];
  type?: "line" | "bar";
  height?: number;
  /** Shown to screen readers; describe what the chart is about. */
  ariaDescription: string;
  xTickFormat?: (ms: number) => string;
  tooltipTimestampFormat?: (ms: number) => string;
  /** When set, a legend with each series' total, clickable to hide or show the series. */
  legend?: { format: (n: number) => string; flightdeck: string };
};

const sum = (points: [number, number][]) => points.reduce((n, [, v]) => n + v, 0);

/** A Kumo time-series chart on tree-shaken ECharts. Loaded lazily (see `./lazy`). */
export default function Timeseries(props: TimeseriesProps) {
  const dark = useDarkMode();
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  // Colors follow each series' position, so hiding one never repaints the others.
  const colored = props.series.map((s, i) => ({ ...s, color: ChartPalette.categorical(i, dark) }));
  return (
    <div className="fd-chart">
      <TimeseriesChart
        echarts={echarts}
        type={props.type ?? "line"}
        gradient={props.type !== "bar"}
        isDarkMode={dark}
        height={props.height ?? 280}
        data={colored
          .filter((s) => !hidden.has(s.name))
          .map((s) => ({ name: s.label ?? s.name, data: s.points, color: s.color }))}
        yAxisMinInterval={1}
        xAxisTickFormat={props.xTickFormat}
        tooltipTimestampFormat={props.tooltipTimestampFormat}
        tooltipFollowCursor="x"
        ariaDescription={props.ariaDescription}
      />
      {props.legend ? (
        <div className="fd-legend">
          {colored.map((s) => (
            <div key={s.name} data-flightdeck={props.legend?.flightdeck}>
              <ChartLegend.LargeItem
                name={s.label ?? s.name}
                color={s.color}
                value={props.legend?.format(sum(s.points)) ?? ""}
                inactive={hidden.has(s.name)}
                onClick={() =>
                  setHidden((h) => {
                    const next = new Set(h);
                    if (!next.delete(s.name)) next.add(s.name);
                    return next;
                  })
                }
              />
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
