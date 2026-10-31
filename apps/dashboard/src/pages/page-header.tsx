import { Text } from "@cloudflare/kumo/components/text";
import type { ReactNode } from "react";

export function PageHeader(props: { title: string; subtitle?: string; actions?: ReactNode }) {
  return (
    <div className="fd-page-header">
      <div>
        <Text variant="heading" size="lg" as="h1">
          {props.title}
        </Text>
        {props.subtitle ? (
          <Text variant="secondary" size="sm">
            {props.subtitle}
          </Text>
        ) : null}
      </div>
      {props.actions ? <div className="fd-page-actions">{props.actions}</div> : null}
    </div>
  );
}
