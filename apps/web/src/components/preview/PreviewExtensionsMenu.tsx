"use client";

import type { DesktopPreviewExtension, DesktopPreviewExtensionInstall } from "@t3tools/contracts";
import { Puzzle } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "~/components/ui/alert-dialog";
import { Button } from "~/components/ui/button";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "~/components/ui/menu";
import { toastManager } from "~/components/ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";

import { previewBridge } from "./previewBridge";

// Display hint only; the desktop app re-reads the tab's real URL before installing.
const WEB_STORE_LISTING = /^https:\/\/(chromewebstore\.google\.com\/detail\/|chrome\.google\.com\/webstore\/detail\/)/;

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : "Something went wrong.");

/**
 * Chrome Web Store extensions of the tab's browser profile: open an
 * extension's popup, add the extension of the store page the tab shows, or
 * remove one. Desktop-rendered tabs only; extensions run in the local guest.
 */
export function PreviewExtensionsMenu(props: { readonly tabId: string; readonly url: string; readonly enabled: boolean }) {
  const { tabId, url, enabled } = props;
  const extensions = previewBridge?.extensions;
  const anchorRef = useRef<HTMLSpanElement | null>(null);
  const [installed, setInstalled] = useState<ReadonlyArray<DesktopPreviewExtension>>([]);
  const [pending, setPending] = useState<DesktopPreviewExtensionInstall | null>(null);
  const [busy, setBusy] = useState(false);
  // Loaded with the page, and again on each navigation: the first call can land before the guest attaches,
  // and an extension may change its icon as pages change.
  useEffect(() => {
    if (enabled) void extensions?.list(tabId).then(setInstalled, () => undefined);
  }, [extensions, tabId, enabled, url]);
  if (!extensions) return null;

  const fail = (title: string) => (error: unknown) => {
    toastManager.add({ type: "error", title, description: errorMessage(error) });
  };
  const refresh = () => void extensions.list(tabId).then(setInstalled, fail("Could not list extensions"));
  const openPopup = (extensionId: string, anchor: Element | null = anchorRef.current) => {
    const rect = anchor?.getBoundingClientRect();
    void extensions
      .openPopup(tabId, extensionId, {
        x: rect?.x ?? 0,
        y: rect?.y ?? 0,
        width: rect?.width ?? 0,
        height: rect?.height ?? 0,
      })
      .catch(fail("Could not open the extension"));
  };
  const prepare = () => {
    setBusy(true);
    void extensions
      .prepareInstall(tabId)
      .then(setPending, fail("Could not get the extension"))
      .finally(() => setBusy(false));
  };
  const confirm = (install: DesktopPreviewExtensionInstall) => {
    setBusy(true);
    void extensions
      .commitInstall(install.token)
      .then((extension) => {
        setPending(null);
        toastManager.add({ type: "success", title: `${extension.name} ${install.update ? "updated" : "added"}` });
        refresh();
      }, fail("Could not install the extension"))
      .finally(() => setBusy(false));
  };
  const cancel = (install: DesktopPreviewExtensionInstall) => {
    setPending(null);
    void extensions.discardInstall(install.token).catch(() => undefined);
  };
  const remove = (extension: DesktopPreviewExtension) =>
    void extensions
      .uninstall(tabId, extension.id)
      .then(() => {
        toastManager.add({ type: "success", title: `${extension.name} removed` });
        refresh();
      }, fail("Could not remove the extension"));

  return (
    <>
      {enabled
        ? installed
            .filter((extension) => extension.icon && extension.hasPopup)
            .map((extension) => (
              <Button
                key={extension.id}
                variant="ghost"
                size="icon-xs"
                type="button"
                aria-label={extension.badgeText ? `${extension.name} (${extension.badgeText})` : extension.name}
                title={extension.name}
                onClick={(event) => openPopup(extension.id, event.currentTarget)}
              >
                <img src={extension.icon} alt="" className="size-4" />
              </Button>
            ))
        : null}
      <Menu onOpenChange={(open) => open && refresh()}>
        <Tooltip>
          <TooltipTrigger
            render={
              <MenuTrigger
                disabled={!enabled}
                render={<Button variant="ghost" size="icon-xs" type="button" aria-label="Extensions" />}
              />
            }
          >
            <span ref={anchorRef} className="contents">
              <Puzzle />
            </span>
          </TooltipTrigger>
          <TooltipPopup>Extensions</TooltipPopup>
        </Tooltip>
        <MenuPopup align="end" sideOffset={6}>
          {installed.length === 0 ? (
            <MenuItem disabled>No extensions in this profile</MenuItem>
          ) : (
            <MenuGroup>
              <MenuGroupLabel>Extensions</MenuGroupLabel>
              {installed.map((extension) => (
                <MenuItem key={extension.id} disabled={!extension.hasPopup} onClick={() => openPopup(extension.id)}>
                  {extension.icon ? <img src={extension.icon} alt="" className="size-4" /> : null}
                  {extension.name}
                  {extension.badgeText ? ` · ${extension.badgeText}` : ""}
                </MenuItem>
              ))}
            </MenuGroup>
          )}
          <MenuSeparator />
          {WEB_STORE_LISTING.test(url) ? (
            <MenuItem onClick={prepare} disabled={busy}>
              Add this extension from the Chrome Web Store
            </MenuItem>
          ) : (
            <MenuItem disabled>Open an extension's Chrome Web Store page to add it</MenuItem>
          )}
          {installed.length > 0 ? (
            <MenuSub>
              <MenuSubTrigger>Remove</MenuSubTrigger>
              <MenuSubPopup>
                {installed.map((extension) => (
                  <MenuItem key={extension.id} onClick={() => remove(extension)}>
                    {extension.name}
                  </MenuItem>
                ))}
              </MenuSubPopup>
            </MenuSub>
          ) : null}
        </MenuPopup>
      </Menu>
      <AlertDialog open={pending !== null} onOpenChange={(open) => !open && pending && cancel(pending)}>
        {pending ? (
          <AlertDialogPopup>
            <AlertDialogHeader>
              <AlertDialogTitle>
                {pending.update ? "Update" : "Add"} "{pending.name}" {pending.version}?
              </AlertDialogTitle>
              <AlertDialogDescription>
                From the Chrome Web Store, for this browser profile only.
                {pending.warnings.length > 0 ? " It can:" : ""}
              </AlertDialogDescription>
            </AlertDialogHeader>
            {pending.warnings.length > 0 ? (
              <ul className="list-disc space-y-1 px-6 text-sm">
                {pending.warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            ) : null}
            {pending.unavailable.length > 0 ? (
              <p className="text-muted-foreground px-6 pt-2 text-sm">
                Not available in T3 Code: {pending.unavailable.join(", ")}. Features that need them will not work.
              </p>
            ) : null}
            <AlertDialogFooter>
              <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
              <Button disabled={busy} onClick={() => confirm(pending)}>
                {pending.update ? "Update extension" : "Add extension"}
              </Button>
            </AlertDialogFooter>
          </AlertDialogPopup>
        ) : null}
      </AlertDialog>
    </>
  );
}
