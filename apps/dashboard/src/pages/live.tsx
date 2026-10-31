import { Badge } from "@cloudflare/kumo/components/badge";
import { Banner } from "@cloudflare/kumo/components/banner";
import { Button } from "@cloudflare/kumo/components/button";
import { Empty } from "@cloudflare/kumo/components/empty";
import { Loader } from "@cloudflare/kumo/components/loader";
import { Surface } from "@cloudflare/kumo/components/surface";
import { Table } from "@cloudflare/kumo/components/table";
import { Text } from "@cloudflare/kumo/components/text";
import { ArrowClockwiseIcon, BroadcastIcon, WarningCircleIcon } from "@phosphor-icons/react";
import type { App } from "../api";
import { LazyTimeseries } from "../charts/lazy";
import { type LiveSummary, RATE_MINUTES, summarize } from "../live/model";
import type { SocketStatus } from "../live/socket";
import { POLL_MS, useLive } from "../live/use-live";
import { PageHeader } from "./page-header";

const count = new Intl.NumberFormat();
const rate = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });
const clock = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });

const STATUS: Record<SocketStatus, { label: string; variant: "success" | "info" | "warning" }> = {
  open: { label: "Live", variant: "success" },
  connecting: { label: "Connecting…", variant: "info" },
  reconnecting: { label: "Reconnecting…", variant: "warning" },
  offline: { label: `Polling every ${POLL_MS / 1000}s`, variant: "warning" },
};

function ConnectionStatus(props: { status: SocketStatus; onReconnect: () => void }) {
  const { label, variant } = STATUS[props.status];
  return (
    <>
      <span role="status" className="fd-connection" data-status={props.status}>
        <Badge variant={variant}>
          <span className="fd-dot" aria-hidden />
          {label}
        </Badge>
      </span>
      {props.status === "open" ? null : (
        <Button
          size="sm"
          variant="ghost"
          icon={<ArrowClockwiseIcon />}
          data-flightdeck="live.reconnect"
          onClick={props.onReconnect}
        >
          Reconnect
        </Button>
      )}
    </>
  );
}

function Stat(props: { label: string; value: string; hint: string }) {
  return (
    <Surface className="fd-card fd-stat">
      <Text variant="secondary" size="sm">
        {props.label}
      </Text>
      <Text variant="heading" size="lg" as="p">
        {props.value}
      </Text>
      <Text variant="secondary" size="xs">
        {props.hint}
      </Text>
    </Surface>
  );
}

function Stats({ summary }: { summary: LiveSummary | null }) {
  const value = (n: number | undefined, f = count) => (n === undefined ? "—" : f.format(n));
  return (
    <div className="fd-stats">
      <Stat
        label="Active sessions"
        value={value(summary?.activeSessions)}
        hint="With an event in the last 5 minutes"
      />
      <Stat
        label="Events per minute"
        value={value(summary?.eventsPerMinute, rate)}
        hint={`Average over the last ${RATE_MINUTES} minutes`}
      />
      <Stat
        label="Page views this hour"
        value={value(summary?.pageViews)}
        hint="Since the top of the hour (UTC)"
      />
    </div>
  );
}

function TopTable(props: {
  title: string;
  label: string;
  rows: { key: string; name: string; detail?: string; count: number }[];
}) {
  return (
    <Surface className="fd-card fd-card-flush">
      <div className="fd-card-title">
        <Text variant="heading" as="h2">
          {props.title}
        </Text>
        <Text variant="secondary" size="xs">
          This and the previous hour
        </Text>
      </div>
      {props.rows.length === 0 ? (
        <p className="fd-table-empty">
          <Text variant="secondary" size="sm">
            Nothing yet
          </Text>
        </p>
      ) : (
        <Table>
          <Table.Header>
            <Table.Row>
              <Table.Head>{props.label}</Table.Head>
              <Table.Head className="fd-num">Events</Table.Head>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {props.rows.map((r) => (
              <Table.Row key={r.key}>
                <Table.Cell>
                  <span className="fd-name">
                    <Text variant="mono">{r.name}</Text>
                    {r.detail ? <Badge variant="secondary">{r.detail}</Badge> : null}
                  </span>
                </Table.Cell>
                <Table.Cell className="fd-num">{count.format(r.count)}</Table.Cell>
              </Table.Row>
            ))}
          </Table.Body>
        </Table>
      )}
    </Surface>
  );
}

export function LivePage({ app }: { app: App }) {
  const { state, socket, reconnect } = useLive(app.id);
  const header = (
    <PageHeader
      title="Live"
      subtitle={`What is happening in ${app.name} now`}
      actions={<ConnectionStatus status={socket} onReconnect={reconnect} />}
    />
  );
  if (state.status === "loading") {
    return (
      <>
        {header}
        <Stats summary={null} />
        <Surface className="fd-card fd-centered">
          <Loader size="lg" aria-label="Loading live data" />
        </Surface>
      </>
    );
  }
  if (state.status !== "ok") {
    const message =
      state.status === "error"
        ? state.message
        : state.status === "not-found"
          ? "This app is no longer registered."
          : "Your session can't load live data. Reload the page to sign in again.";
    return (
      <>
        {header}
        <Banner
          variant="error"
          icon={<WarningCircleIcon weight="fill" />}
          title="Couldn't load live data"
          description={message}
        />
      </>
    );
  }
  const summary = summarize(state.view, Math.max(Date.now(), state.view.now));
  return (
    <>
      {header}
      <Stats summary={summary} />
      {summary.hasEvents ? (
        <>
          <Surface className="fd-card">
            <div className="fd-card-title">
              <Text variant="heading" as="h2">
                Event volume
              </Text>
              <Text variant="secondary" size="xs">
                Per minute, last 60 minutes
              </Text>
            </div>
            <LazyTimeseries
              type="bar"
              height={220}
              series={[{ name: "events", label: "Events", points: summary.perMinute }]}
              ariaDescription={`Events per minute in ${app.name} over the last 60 minutes`}
              xTickFormat={(ms) => clock.format(ms)}
            />
          </Surface>
          <div className="fd-grid-2">
            <TopTable
              title="Top pages"
              label="Page"
              rows={summary.topPages.map((p) => ({ key: p.name, ...p }))}
            />
            <TopTable
              title="Top events"
              label="Event"
              rows={summary.topEvents.map((e) => ({
                key: `${e.kind}:${e.name}`,
                name: e.name,
                detail: e.kind,
                count: e.count,
              }))}
            />
          </div>
        </>
      ) : (
        <Surface className="fd-card">
          <Empty
            icon={<BroadcastIcon size={40} className="fd-pulse" />}
            title="Waiting for the first event"
            description={`Nothing from ${app.name} in the last two hours. Events appear here the moment they arrive.`}
          />
        </Surface>
      )}
    </>
  );
}
