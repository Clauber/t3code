"use client";

import { describeManagedControl } from "@t3tools/client-runtime/managed-browser";
import {
  previewStreamControlLabel,
  type PreviewStreamControl,
  type PreviewStreamInput,
  type PreviewStreamSurface,
} from "@t3tools/client-runtime/preview/server-browser-stream";
import { useEffect, useState } from "react";

import { Button } from "~/components/ui/button";
import { Toggle, ToggleGroup } from "~/components/ui/toggle-group";
import { cn } from "~/lib/utils";

/**
 * Who has control of a streamed tab, and what a person can do about it. A shared (managed) browser reports its
 * surface, which adds the page / full window choice and the held and paused states; an ordinary tab keeps its
 * plain take and release control.
 */
export function ServerBrowserControlBar(props: {
  readonly control: PreviewStreamControl | null;
  readonly surface: PreviewStreamSurface | null;
  readonly position: "top" | "bottom";
  readonly send: (input: PreviewStreamInput) => void;
}) {
  const { control, surface, position, send } = props;
  // A held control counts down; the clock only runs while there is something to count.
  const [now, setNow] = useState(() => Date.now());
  const holdEndsAt = control?.holdExpiresAtMs;
  useEffect(() => {
    if (holdEndsAt === undefined) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [holdEndsAt]);
  const managedControl = surface === null ? null : describeManagedControl(control, now);
  return (
    <div
      className={cn(
        "visible relative z-20 flex shrink-0 flex-wrap items-center justify-between gap-2 border-border bg-background px-2 py-1",
        position === "bottom" ? "order-last border-t" : "border-b",
      )}
    >
      <div className="flex min-w-0 flex-col">
        <span role="status" className="text-xs text-muted-foreground">
          {managedControl ? managedControl.label : previewStreamControlLabel(control)}
        </span>
        {managedControl?.detail ? (
          <span className="text-[11px] text-muted-foreground/80">{managedControl.detail}</span>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {surface ? (
          <ToggleGroup
            aria-label="What to show"
            variant="segmented"
            value={[surface.current]}
            onValueChange={(next) => {
              const choice = next[0];
              if (choice === "page" || choice === "window")
                send({ type: "surface", surface: choice });
            }}
          >
            <Toggle value="page">Page</Toggle>
            {/* A disabled control cannot be hovered, so the reason sits on its wrapper. */}
            <span title={surface.window.available ? undefined : surface.window.reason}>
              <Toggle
                value="window"
                disabled={!surface.window.available}
                aria-description={surface.window.available ? undefined : surface.window.reason}
              >
                Full window
              </Toggle>
            </span>
          </ToggleGroup>
        ) : null}
        {managedControl ? (
          managedControl.action ? (
            <Button
              variant="outline"
              size="xs"
              onClick={() =>
                send({
                  type: managedControl.action === "release" ? "releaseControl" : "takeControl",
                })
              }
            >
              {managedControl.actionLabel}
            </Button>
          ) : null
        ) : control?.canOperate ? (
          <Button
            variant="outline"
            size="xs"
            disabled={control.controller === "another-viewer"}
            onClick={() =>
              send({ type: control.controller === "you" ? "releaseControl" : "takeControl" })
            }
          >
            {control.controller === "you" ? "Release control" : "Take control"}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
