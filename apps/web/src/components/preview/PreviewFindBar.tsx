import { ChevronDown, ChevronUp, X } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";

/** The find-in-page surface every Electron `<webview>` already carries. */
interface FindableWebview extends HTMLElement {
  findInPage(text: string, options?: { forward?: boolean; findNext?: boolean }): number;
  stopFindInPage(action: "clearSelection" | "keepSelection" | "activateSelection"): void;
}

/** The page's `<webview>` when it holds keyboard focus, which is where Cmd+F came from. */
export function focusedPreviewWebview(runtimeTabId: string): FindableWebview | null {
  const active = document.activeElement;
  return active instanceof HTMLElement &&
    active.tagName.toLowerCase() === "webview" &&
    active.dataset.previewTab === runtimeTabId
    ? (active as FindableWebview)
    : null;
}

/** Find in the page, as a browser's Cmd+F does: Enter for next, Shift+Enter for previous, Escape to close. */
export function PreviewFindBar({ webview, onClose }: { webview: FindableWebview; onClose: () => void }) {
  const [text, setText] = useState("");
  const [result, setResult] = useState<{ active: number; matches: number } | null>(null);

  useEffect(() => {
    const onFound = (event: Event) => {
      const found = (event as Event & { result: { activeMatchOrdinal: number; matches: number } }).result;
      setResult({ active: found.activeMatchOrdinal, matches: found.matches });
    };
    webview.addEventListener("found-in-page", onFound);
    return () => {
      webview.removeEventListener("found-in-page", onFound);
      webview.stopFindInPage("clearSelection");
    };
  }, [webview]);

  const search = (value: string, next?: { forward: boolean }) => {
    if (value === "") {
      webview.stopFindInPage("clearSelection");
      setResult(null);
      return;
    }
    webview.findInPage(value, next ? { forward: next.forward, findNext: true } : {});
  };
  const close = () => {
    onClose();
    webview.focus();
  };

  return (
    <div className="flex shrink-0 items-center gap-1 border-b px-3 py-1.5" role="search">
      <Input
        autoFocus
        aria-label="Find in page"
        placeholder="Find in page"
        value={text}
        onChange={(event) => {
          setText(event.target.value);
          search(event.target.value);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            search(text, { forward: !event.shiftKey });
          } else if (event.key === "Escape") {
            event.preventDefault();
            close();
          }
        }}
      />
      <span className="min-w-12 text-center text-xs text-muted-foreground tabular-nums">
        {result && text ? `${result.active}/${result.matches}` : ""}
      </span>
      <Button size="icon-xs" variant="ghost" aria-label="Previous match" disabled={!text} onClick={() => search(text, { forward: false })}>
        <ChevronUp />
      </Button>
      <Button size="icon-xs" variant="ghost" aria-label="Next match" disabled={!text} onClick={() => search(text, { forward: true })}>
        <ChevronDown />
      </Button>
      <Button size="icon-xs" variant="ghost" aria-label="Close find" onClick={close}>
        <X />
      </Button>
    </div>
  );
}
