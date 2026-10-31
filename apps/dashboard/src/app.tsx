import { Banner } from "@cloudflare/kumo/components/banner";
import { Button } from "@cloudflare/kumo/components/button";
import { Empty } from "@cloudflare/kumo/components/empty";
import { Loader } from "@cloudflare/kumo/components/loader";
import { Sidebar } from "@cloudflare/kumo/components/sidebar";
import { Surface } from "@cloudflare/kumo/components/surface";
import { LinkProvider } from "@cloudflare/kumo/utils";
import {
  AirplaneTiltIcon,
  CompassIcon,
  SignInIcon,
  SquaresFourIcon,
  WarningCircleIcon,
} from "@phosphor-icons/react";
import { type ReactNode, useEffect } from "react";
import type { App as AppRecord } from "./api";
import { AppSwitcher } from "./app-switcher";
import { RouterLink } from "./link";
import { ANALYTICS_NAV, NAV_ITEMS, type NavItem, SETTINGS_NAV } from "./nav";
import { AppsPage } from "./pages/apps";
import { ComingSoonPage } from "./pages/coming-soon";
import { LivePage } from "./pages/live";
import { TrendsPage } from "./pages/trends";
import {
  navigate,
  type PageId,
  pageFrom,
  pageHref,
  selectedAppParam,
  useLocation,
  withApp,
} from "./router";
import { type AppsState, useApps } from "./use-apps";

function NavGroup(props: { label: string; items: NavItem[]; current: PageId | null }) {
  return (
    <Sidebar.Group>
      <Sidebar.GroupLabel>{props.label}</Sidebar.GroupLabel>
      <Sidebar.Menu>
        {props.items.map((item) => (
          <Sidebar.MenuButton
            key={item.id}
            href={pageHref(item.id)}
            icon={item.icon}
            tooltip={item.label}
            active={item.id === props.current}
            aria-current={item.id === props.current ? "page" : undefined}
            data-flightdeck={`nav.${item.id}`}
          >
            {item.label}
            {item.soon ? <Sidebar.MenuBadge>Soon</Sidebar.MenuBadge> : null}
          </Sidebar.MenuButton>
        ))}
      </Sidebar.Menu>
    </Sidebar.Group>
  );
}

function Centered({ children }: { children: ReactNode }) {
  return <Surface className="fd-card fd-centered">{children}</Surface>;
}

/** What the main area shows for the current page, apps state and selection. */
function Content(props: {
  page: PageId | null;
  state: AppsState;
  selected: AppRecord | null;
  reload: () => void;
}) {
  const { page, state, selected } = props;
  if (page === null) {
    return (
      <Centered>
        <Empty
          icon={<CompassIcon size={40} />}
          title="Page not found"
          description="There is nothing at this address."
          contents={
            <Button data-flightdeck="notfound.home" onClick={() => navigate(pageHref("live"))}>
              Go to Live
            </Button>
          }
        />
      </Centered>
    );
  }
  const item = NAV_ITEMS.find((i) => i.id === page);
  if (item?.soon) return <ComingSoonPage item={item} />;
  if (state.status === "loading") {
    return (
      <Centered>
        <Loader size="lg" aria-label="Loading apps" />
      </Centered>
    );
  }
  if (state.status === "signed-out") {
    return (
      <Centered>
        <Empty
          icon={<SignInIcon size={40} />}
          title="You are signed out"
          description="Your Cloudflare Access session has ended. Sign in again to see your apps."
          contents={
            <Button
              variant="primary"
              data-flightdeck="auth.signin"
              onClick={() => location.reload()}
            >
              Sign in
            </Button>
          }
        />
      </Centered>
    );
  }
  if (state.status === "error") {
    return (
      <Banner
        variant="error"
        icon={<WarningCircleIcon weight="fill" />}
        title="Couldn't load apps"
        description={state.message}
        action={
          <Button size="sm" data-flightdeck="apps.retry" onClick={props.reload}>
            Try again
          </Button>
        }
      />
    );
  }
  if (page === "apps") return <AppsPage apps={state.apps} selected={selected} />;
  if (!selected) {
    return (
      <Centered>
        <Empty
          icon={<SquaresFourIcon size={40} />}
          title="No apps yet"
          description="Connect an app to Flightdeck to see its analytics here."
          contents={
            <Button
              variant="primary"
              data-flightdeck="empty.apps"
              onClick={() => navigate(pageHref("apps"))}
            >
              Go to Apps
            </Button>
          }
        />
      </Centered>
    );
  }
  return page === "live" ? <LivePage app={selected} /> : <TrendsPage app={selected} />;
}

export function App() {
  const href = useLocation();
  const [state, reload] = useApps();
  const page = pageFrom(location.pathname);
  const apps = state.status === "ok" ? state.apps : [];
  const param = selectedAppParam();
  const selected = apps.find((a) => a.id === param) ?? apps[0] ?? null;

  // Canonicalize the URL: `/` becomes `/live`, and `?app=` names the app actually shown.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `href` changes on every navigation.
  useEffect(() => {
    if (location.pathname === "/") navigate(`/live${location.search}`, { replace: true });
    else if (state.status === "ok" && (selected?.id ?? null) !== param) {
      navigate(withApp(selected?.id ?? null), { replace: true });
    }
  }, [href, state.status, selected?.id, param]);

  const label = NAV_ITEMS.find((i) => i.id === page)?.label ?? "Not found";
  useEffect(() => {
    document.title = `${label} · Flightdeck`;
  }, [label]);

  return (
    <LinkProvider component={RouterLink}>
      <Sidebar.Provider className="fd-shell">
        <Sidebar aria-label="Flightdeck">
          <Sidebar.Header>
            <a
              className="fd-brand"
              href={pageHref("live")}
              data-flightdeck="nav.home"
              onClick={(ev) => {
                ev.preventDefault();
                navigate(pageHref("live"));
              }}
            >
              <AirplaneTiltIcon size={20} weight="duotone" aria-hidden />
              <span>Flightdeck</span>
            </a>
          </Sidebar.Header>
          <Sidebar.Content>
            <nav aria-label="Primary">
              <NavGroup label="Analytics" items={ANALYTICS_NAV} current={page} />
              <NavGroup label="Settings" items={SETTINGS_NAV} current={page} />
            </nav>
          </Sidebar.Content>
        </Sidebar>
        <div className="fd-main">
          <header className="fd-header">
            <Sidebar.Trigger aria-label="Toggle navigation" data-flightdeck="nav.toggle" />
            <AppSwitcher
              state={state}
              selected={selected}
              onSelect={(appId) => navigate(withApp(appId))}
            />
          </header>
          <main className="fd-content" aria-label={label}>
            <Content page={page} state={state} selected={selected} reload={reload} />
          </main>
        </div>
      </Sidebar.Provider>
    </LinkProvider>
  );
}
