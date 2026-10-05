import type { PullRequestCheck } from "@t3tools/contracts";
import { formatDuration } from "@t3tools/shared/orchestrationTiming";
import { HammerIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { cn } from "~/lib/utils";

import { Button } from "../ui/button";
import {
  groupPullRequestChecksByWorkflow,
  pullRequestCheckDurationMs,
  pullRequestCheckNameInWorkflow,
  pullRequestFindingKey,
  type PullRequestFinding,
} from "./pullRequestDetail.logic";
import { PullRequestCheckStatusIcon, pullRequestCheckStatusLabel } from "./pullRequestPresentation";

/**
 * Wall clock for running checks' elapsed time. Ticks once a second only while something is
 * running and the list is mounted, which is only while its section is open.
 */
function useNowWhileRunning(running: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [running]);
  return now;
}

function workflowGroupSummary(attention: number, running: number, total: number): string {
  if (attention > 0) return `${attention} of ${total} need attention`;
  if (running > 0) return `${running} of ${total} running`;
  return `${total} ${total === 1 ? "check" : "checks"}`;
}

/** The detail panel's checks, grouped by workflow with each run's duration. */
export function PullRequestChecksList({
  checks,
  onOpenCheck,
  pendingFinding,
  fixCheckLabel,
  onFixFinding,
}: {
  checks: ReadonlyArray<PullRequestCheck>;
  onOpenCheck: (url: string) => void;
  pendingFinding?: string | null | undefined;
  fixCheckLabel: string;
  onFixFinding?: ((finding: PullRequestFinding) => void) | undefined;
}) {
  const groups = groupPullRequestChecksByWorkflow(checks);
  const now = useNowWhileRunning(groups.some((group) => group.running > 0));
  // A lone unnamed group is a host that names no workflows; a heading would only say "Other".
  const showHeadings = groups.length > 1 || groups[0]?.workflowName != null;
  return (
    <div className="flex flex-col gap-2">
      {groups.map((group) => (
        <div key={group.workflowName ?? ""} className="flex flex-col">
          {showHeadings ? (
            <div className="flex items-center gap-2 px-2 pt-1 pb-0.5 text-xs">
              <span className="min-w-0 flex-1 truncate font-medium">
                {group.workflowName ?? "Other checks"}
              </span>
              <span className="shrink-0 text-muted-foreground">
                {workflowGroupSummary(group.attention, group.running, group.checks.length)}
              </span>
            </div>
          ) : null}
          {group.checks.map((check, index) => {
            const finding = { kind: "check", check } as const;
            const failing = check.status === "failure" || check.status === "cancelled";
            const durationMs = pullRequestCheckDurationMs(check, now);
            return (
              <div
                // Position too: the host decides how many runs share a name, and a repeated
                // key would be a rendering fault on top of whatever the list already says.
                key={`${index}:${check.name}:${check.url ?? ""}`}
                className="group flex items-center gap-2 rounded-md pr-1 hover:bg-accent/60"
              >
                <button
                  type="button"
                  disabled={!check.url}
                  onClick={() => check.url && onOpenCheck(check.url)}
                  className={cn(
                    "flex min-w-0 flex-1 items-start gap-2 rounded-md px-2 py-1.5 text-left text-xs leading-5 [&>svg]:mt-0.5",
                    check.url ? "cursor-pointer" : "cursor-default",
                  )}
                >
                  <PullRequestCheckStatusIcon status={check.status} />
                  <span className="min-w-0 flex-1 wrap-anywhere">
                    {pullRequestCheckNameInWorkflow(check)}
                    {check.description ? (
                      <span className="block truncate text-muted-foreground">
                        {check.description}
                      </span>
                    ) : null}
                  </span>
                  <span className="shrink-0 text-muted-foreground tabular-nums">
                    {pullRequestCheckStatusLabel(check)}
                    {durationMs === null ? null : ` · ${formatDuration(durationMs)}`}
                  </span>
                </button>
                {/* Only where there is something to fix. A passing check has no failure to
                    reproduce, and the button would be an invitation to waste a thread. */}
                {onFixFinding && failing ? (
                  <Button
                    size="xs"
                    variant="ghost"
                    className="shrink-0"
                    disabled={pendingFinding !== null && pendingFinding !== undefined}
                    onClick={() => onFixFinding(finding)}
                  >
                    <HammerIcon className="size-3" />
                    {pendingFinding === pullRequestFindingKey(finding)
                      ? "Preparing..."
                      : fixCheckLabel}
                  </Button>
                ) : null}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}
