import {
  ArrowsClockwiseIcon,
  ChartLineIcon,
  FunnelIcon,
  type Icon,
  PathIcon,
  PulseIcon,
  SquaresFourIcon,
} from "@phosphor-icons/react";
import type { PageId } from "./router";

export type NavItem = { id: PageId; label: string; icon: Icon; soon?: boolean; demo?: boolean };

export const ANALYTICS_NAV: NavItem[] = [
  { id: "live", label: "Live", icon: PulseIcon },
  { id: "trends", label: "Trends", icon: ChartLineIcon },
  { id: "workflows", label: "Workflows", icon: PathIcon, demo: true },
  { id: "journeys", label: "Journeys", icon: PathIcon, soon: true },
  { id: "funnels", label: "Funnels", icon: FunnelIcon, soon: true },
  { id: "retention", label: "Retention", icon: ArrowsClockwiseIcon, soon: true },
];

export const SETTINGS_NAV: NavItem[] = [{ id: "apps", label: "Apps", icon: SquaresFourIcon }];

export const NAV_ITEMS = [...ANALYTICS_NAV, ...SETTINGS_NAV];
