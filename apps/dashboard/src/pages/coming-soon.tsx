import { Empty } from "@cloudflare/kumo/components/empty";
import { Surface } from "@cloudflare/kumo/components/surface";
import type { NavItem } from "../nav";
import { PageHeader } from "./page-header";

export function ComingSoonPage({ item }: { item: NavItem }) {
  const Icon = item.icon;
  return (
    <>
      <PageHeader title={item.label} />
      <Surface className="fd-card">
        <Empty
          icon={<Icon size={40} />}
          title={`${item.label} is coming soon`}
          description="This view is planned for a later Flightdeck release."
        />
      </Surface>
    </>
  );
}
