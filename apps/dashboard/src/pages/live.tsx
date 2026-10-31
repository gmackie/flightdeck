import { Empty } from "@cloudflare/kumo/components/empty";
import { Surface } from "@cloudflare/kumo/components/surface";
import { Text } from "@cloudflare/kumo/components/text";
import { PulseIcon } from "@phosphor-icons/react";
import type { App } from "../api";
import { PageHeader } from "./page-header";

const STATS = ["Active sessions", "Events per minute", "Page views this hour"];

export function LivePage({ app }: { app: App }) {
  return (
    <>
      <PageHeader title="Live" subtitle={`What is happening in ${app.name} now`} />
      <div className="fd-stats">
        {STATS.map((label) => (
          <Surface key={label} className="fd-card fd-stat">
            <Text variant="secondary" size="sm">
              {label}
            </Text>
            <Text variant="heading" size="lg" as="p">
              —
            </Text>
          </Surface>
        ))}
      </div>
      <Surface className="fd-card">
        <Empty
          icon={<PulseIcon size={40} />}
          title="Live view is on its way"
          description="Active sessions, top pages and events will stream here as they arrive."
        />
      </Surface>
    </>
  );
}
