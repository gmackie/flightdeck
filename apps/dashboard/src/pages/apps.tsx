import { Badge } from "@cloudflare/kumo/components/badge";
import { Button } from "@cloudflare/kumo/components/button";
import { Dialog } from "@cloudflare/kumo/components/dialog";
import { Empty } from "@cloudflare/kumo/components/empty";
import { Surface } from "@cloudflare/kumo/components/surface";
import { Table } from "@cloudflare/kumo/components/table";
import { Text } from "@cloudflare/kumo/components/text";
import { PlusIcon, SquaresFourIcon, XIcon } from "@phosphor-icons/react";
import type { App } from "../api";
import { navigate, pageHref } from "../router";
import { PageHeader } from "./page-header";

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });

/** Binding snippet for an app Worker's wrangler config. */
const bindingSnippet = (appId: string) => `"services": [
  {
    "binding": "FLIGHTDECK",
    "service": "flightdeck",
    "entrypoint": "Ingest",
    "props": { "appId": "${appId}" }
  }
]`;

function RegisterAppDialog({ appId }: { appId: string }) {
  return (
    <Dialog.Root>
      <Dialog.Trigger
        render={(p) => (
          <Button {...p} variant="primary" icon={<PlusIcon />} data-flightdeck="apps.add.open">
            Connect an app
          </Button>
        )}
      />
      <Dialog size="lg" className="fd-dialog">
        <div className="fd-dialog-header">
          <Dialog.Title className="fd-dialog-title">Connect an app</Dialog.Title>
          <Dialog.Close
            render={(p) => (
              <Button
                {...p}
                variant="ghost"
                shape="square"
                icon={<XIcon />}
                aria-label="Close"
                data-flightdeck="apps.add.close"
              />
            )}
          />
        </div>
        <Dialog.Description className="fd-dialog-body">
          Registering apps from the dashboard is coming soon. Once an app is registered, add a
          service binding to its Worker, wrap its fetch handler with <code>withFlightdeck</code>,
          and load <code>@flightdeckhq/browser</code> in its pages.
        </Dialog.Description>
        <figure className="fd-figure">
          <figcaption className="sr-only">Service binding example</figcaption>
          <pre className="fd-code">{bindingSnippet(appId)}</pre>
        </figure>
      </Dialog>
    </Dialog.Root>
  );
}

export function AppsPage({ apps, selected }: { apps: App[]; selected: App | null }) {
  return (
    <>
      <PageHeader
        title="Apps"
        subtitle="Apps reporting to this Flightdeck"
        actions={<RegisterAppDialog appId={selected?.id ?? "app_example"} />}
      />
      <Surface className="fd-card fd-card-flush">
        {apps.length === 0 ? (
          <Empty
            icon={<SquaresFourIcon size={40} />}
            title="No apps yet"
            description="Connect your first app to start collecting events."
          />
        ) : (
          <Table>
            <Table.Header>
              <Table.Row>
                <Table.Head>Name</Table.Head>
                <Table.Head>App ID</Table.Head>
                <Table.Head>Created</Table.Head>
                <Table.Head>
                  <span className="sr-only">Actions</span>
                </Table.Head>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {apps.map((app) => {
                const current = app.id === selected?.id;
                return (
                  <Table.Row key={app.id} variant={current ? "selected" : "default"}>
                    <Table.Cell>
                      <span className="fd-app-name">
                        {app.name}
                        {current ? <Badge variant="secondary">Selected</Badge> : null}
                      </span>
                    </Table.Cell>
                    <Table.Cell>
                      <Text variant="mono-secondary">{app.id}</Text>
                    </Table.Cell>
                    <Table.Cell>{dateFormat.format(app.created_at)}</Table.Cell>
                    <Table.Cell className="fd-cell-actions">
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={current}
                        aria-label={`View ${app.name}`}
                        data-flightdeck="apps.select"
                        onClick={() => navigate(pageHref("live", app.id))}
                      >
                        View
                      </Button>
                    </Table.Cell>
                  </Table.Row>
                );
              })}
            </Table.Body>
          </Table>
        )}
      </Surface>
    </>
  );
}
