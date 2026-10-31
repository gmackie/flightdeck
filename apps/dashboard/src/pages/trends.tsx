import { Empty } from "@cloudflare/kumo/components/empty";
import { Surface } from "@cloudflare/kumo/components/surface";
import { ChartLineIcon } from "@phosphor-icons/react";
import type { App } from "../api";
import { PageHeader } from "./page-header";
import { RangeFilter } from "./range-filter";

export function TrendsPage({ app }: { app: App }) {
  return (
    <>
      <PageHeader
        title="Trends"
        subtitle={`Event counts over time for ${app.name}`}
        actions={<RangeFilter page="trends" />}
      />
      <Surface className="fd-card">
        <Empty
          icon={<ChartLineIcon size={40} />}
          title="Trends are on their way"
          description="Event counts over time, with breakdowns by event name, page and property."
        />
      </Surface>
    </>
  );
}
