import { Banner } from "@cloudflare/kumo/components/banner";
import { Empty } from "@cloudflare/kumo/components/empty";
import { Loader } from "@cloudflare/kumo/components/loader";
import { Surface } from "@cloudflare/kumo/components/surface";
import { Text } from "@cloudflare/kumo/components/text";
import { ChartLineIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { useState } from "react";
import type { App } from "../api";
import { LazyTimeseries } from "../charts/lazy";
import {
  BREAKDOWNS,
  type Breakdown,
  OTHER,
  type TrendsView,
  useTrends,
} from "../trends/use-trends";
import { PageHeader } from "./page-header";
import { type Range, RangeFilter, Segmented } from "./range-filter";

const count = new Intl.NumberFormat();
const hourTick = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });
const hourFull = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
// Daily buckets are UTC days, so label them in UTC to keep each bar on its own date.
const day = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
const dayFull = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeZone: "UTC" });

const SERIES_NOUN: Record<Breakdown, string> = { kind: "kind", name: "event", page: "page" };

function Totals({ view }: { view: TrendsView | null }) {
  const top = view?.series.find((s) => s.name !== OTHER);
  return (
    <div className="fd-stats">
      <Surface className="fd-card fd-stat">
        <Text variant="secondary" size="sm">
          Events
        </Text>
        <Text variant="heading" size="lg" as="p">
          {view ? count.format(view.totals.events) : "—"}
        </Text>
      </Surface>
      <Surface className="fd-card fd-stat">
        <Text variant="secondary" size="sm">
          Sessions
        </Text>
        <Text variant="heading" size="lg" as="p">
          {view ? count.format(view.totals.sessions) : "—"}
        </Text>
        <Text variant="secondary" size="xs">
          Unique per hour, summed
        </Text>
      </Surface>
      <Surface className="fd-card fd-stat">
        <Text variant="secondary" size="sm">
          Top {view ? SERIES_NOUN[view.breakdown] : "series"}
        </Text>
        <div className="fd-ellipsis">
          <Text variant="heading" size="lg" as="p">
            {top ? top.name : "—"}
          </Text>
        </div>
        {top ? (
          <Text variant="secondary" size="xs">
            {count.format(top.total)} events
          </Text>
        ) : null}
      </Surface>
    </div>
  );
}

function TrendsChart({ view, loading }: { view: TrendsView; loading: boolean }) {
  const hourly = view.bucket === "hour";
  if (view.totals.events === 0) {
    return (
      <Empty
        icon={<ChartLineIcon size={40} />}
        title="No events in this range"
        description="Counts appear here as events arrive. Try a longer range."
      />
    );
  }
  return (
    <div aria-busy={loading || undefined}>
      <LazyTimeseries
        series={view.series.map((s) => ({
          name: s.name,
          label: s.name === OTHER ? "Other" : s.name,
          points: view.buckets.map((t, i): [number, number] => [t, s.counts[i] ?? 0]),
        }))}
        ariaDescription={`Events per ${hourly ? "hour" : "day"} by ${SERIES_NOUN[view.breakdown]}`}
        xTickFormat={(ms) => (hourly ? hourTick : day).format(ms)}
        tooltipTimestampFormat={(ms) => (hourly ? hourFull : dayFull).format(ms)}
        legend={{ format: (n) => count.format(n), flightdeck: "trends.series" }}
      />
    </div>
  );
}

export function TrendsPage({ app }: { app: App }) {
  const [range, setRange] = useState<Range>("24h");
  const [breakdown, setBreakdown] = useState<Breakdown>("kind");
  const state = useTrends(app.id, range, breakdown);
  const view =
    state.status === "ok" ? state.view : state.status === "loading" ? state.previous : null;

  let body: React.ReactNode;
  if (view) body = <TrendsChart view={view} loading={state.status === "loading"} />;
  else if (state.status === "loading") {
    body = (
      <div className="fd-centered">
        <Loader size="lg" aria-label="Loading trends" />
      </div>
    );
  } else {
    body = (
      <Banner
        variant="error"
        icon={<WarningCircleIcon weight="fill" />}
        title="Couldn't load trends"
        description={
          state.status === "error"
            ? state.message
            : state.status === "not-found"
              ? "This app is no longer registered."
              : "Your session can't load trends. Reload the page to sign in again."
        }
      />
    );
  }

  return (
    <>
      <PageHeader
        title="Trends"
        subtitle={`Event counts over time for ${app.name}`}
        actions={
          <>
            <Segmented
              label="Break down by"
              page="trends"
              name="breakdown"
              options={BREAKDOWNS}
              value={breakdown}
              onChange={setBreakdown}
            />
            <RangeFilter page="trends" value={range} onChange={setRange} />
          </>
        }
      />
      <Totals view={view} />
      <Surface className="fd-card">
        <div className="fd-card-title">
          <Text variant="heading" as="h2">
            Events per {view?.bucket === "day" ? "day" : "hour"}
          </Text>
          <Text variant="secondary" size="xs">
            Top {SERIES_NOUN[breakdown]}s · UTC {view?.bucket === "day" ? "days" : "hours"}
          </Text>
        </div>
        {body}
      </Surface>
    </>
  );
}
