import { Loader } from "@cloudflare/kumo/components/loader";
import { lazy, Suspense } from "react";
import type { TimeseriesProps } from "./timeseries";

// ECharts and Kumo's chart wrapper load in their own chunk, only on pages that draw charts.
const Timeseries = lazy(() => import("./timeseries"));

export function LazyTimeseries(props: TimeseriesProps) {
  return (
    <Suspense
      fallback={
        <div className="fd-chart-loading" style={{ height: props.height ?? 280 }}>
          <Loader aria-label="Loading chart" />
        </div>
      }
    >
      <Timeseries {...props} />
    </Suspense>
  );
}
