import type { LinkComponentProps } from "@cloudflare/kumo/utils";
import { forwardRef, type MouseEvent } from "react";
import { navigate } from "./router";

/** Anchor that navigates client-side for plain same-origin clicks; Kumo uses it for `href`s. */
export const RouterLink = forwardRef<HTMLAnchorElement, LinkComponentProps>(
  ({ to: _to, onClick, ...props }, ref) => {
    const handle = (ev: MouseEvent<HTMLAnchorElement>) => {
      onClick?.(ev);
      const href = ev.currentTarget.getAttribute("href");
      const modified = ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey || ev.button !== 0;
      if (ev.defaultPrevented || modified || props.target || !href?.startsWith("/")) return;
      ev.preventDefault();
      navigate(href);
    };
    // biome-ignore lint/a11y: a real link (href and children arrive in props); Enter fires click.
    return <a ref={ref} {...props} onClick={handle} />;
  },
);
RouterLink.displayName = "RouterLink";
