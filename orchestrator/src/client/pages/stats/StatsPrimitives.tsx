/**
 * Shared marks for the Stats panels.
 *
 * Every chart here is either single-hue magnitude or a reserved status colour.
 * That is deliberate: the palette's `--chart-*` tokens are muted by design and
 * do not separate well enough to carry a multi-series categorical chart, and
 * each panel shows its exact numbers anyway, so hue never has to do the work of
 * telling two series apart.
 */

import type React from "react";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { barWidth } from "./format";

export const Panel: React.FC<{
  title: string;
  note?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}> = ({ title, note, children, className }) => (
  <Card className={className}>
    <CardContent className="space-y-3 p-4">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="font-semibold text-sm">{title}</h2>
        {note ? (
          <span className="text-muted-foreground text-xs">{note}</span>
        ) : null}
      </div>
      {children}
    </CardContent>
  </Card>
);

export const StatTile: React.FC<{
  label: string;
  value: string;
  detail?: React.ReactNode;
}> = ({ label, value, detail }) => (
  <Card>
    <CardContent className="p-4">
      <div className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
        {label}
      </div>
      <div className="mt-1 font-semibold text-3xl tabular-nums leading-tight">
        {value}
      </div>
      {detail ? (
        <div className="mt-1 text-muted-foreground text-xs">{detail}</div>
      ) : null}
    </CardContent>
  </Card>
);

/** A single-hue magnitude bar with its own track. */
export const Bar: React.FC<{
  value: number;
  max: number;
  className?: string;
  title?: string;
}> = ({ value, max, className, title }) => (
  <div
    className="h-2 w-full overflow-hidden rounded-full bg-muted"
    title={title}
  >
    <div
      className={cn("h-full rounded-full bg-chart-1", className)}
      style={{ width: `${barWidth(value, max)}%` }}
    />
  </div>
);

/**
 * Says why a panel is empty. A stats page that renders a blank card is
 * indistinguishable from one that is broken, and "no data yet" and "this cannot
 * be computed" are different messages the reader needs told apart.
 */
export const EmptyNote: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => (
  <p className="rounded-md border border-border border-dashed bg-muted/30 p-3 text-muted-foreground text-xs">
    {children}
  </p>
);

/** A caveat attached to a figure that is true but easy to misread. */
export const Caveat: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => <p className="text-muted-foreground text-xs">{children}</p>;

export const StatsTable: React.FC<{
  head: React.ReactNode;
  children: React.ReactNode;
}> = ({ head, children }) => (
  <div className="overflow-x-auto">
    <table className="w-full text-sm">
      <thead>
        <tr className="border-border border-b text-muted-foreground text-xs uppercase tracking-wide">
          {head}
        </tr>
      </thead>
      <tbody>{children}</tbody>
    </table>
  </div>
);
