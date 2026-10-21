import previewStreamScript from "@t3tools/mobile-preview-stream";
import {
  previewStreamControlLabel,
  previewStreamHostSetupMessage,
  type PreviewStreamSurface,
  type PreviewStreamControl,
  type PreviewStreamDownload,
  type PreviewStreamFileChooser,
  type PreviewStreamInput,
} from "@t3tools/client-runtime/preview/server-browser-stream";
import { describeManagedControl } from "@t3tools/client-runtime/managed-browser";
import type { EnvironmentId, PreviewStreamHostSetup } from "@t3tools/contracts";
import {
  useEffect,
  useEffectEvent,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type Ref,
} from "react";
import { ActivityIndicator, Alert, Platform, Pressable, TextInput, View } from "react-native";
import { WebView } from "react-native-webview";
import * as Clipboard from "expo-clipboard";

import { AppText } from "../../components/AppText";
import { downloadAndShareAttachment } from "../../lib/attachmentDownload";
import { beginForegroundHandoff } from "../../lib/foreground-handoff";
import { uuidv4 } from "../../lib/uuid";
import { usePreviewStreamAccess } from "../../state/preview";

import {
  previewStreamDocument,
  previewStreamMessage,
  type PreviewStreamConfiguration,
} from "./preview-stream-document";

export interface PreviewStreamRef {
  /** Navigation requires current control of the browser. */
  readonly command: (input: PreviewStreamInput) => void;
  readonly togglePictureInPicture: () => void;
}

export interface PreviewPictureInPictureState {
  readonly supported: boolean;
  readonly active: boolean;
}

type NativeStreamBridge = {
  readonly ref?: Ref<PreviewStreamRef>;
  /** Refresh stream access; new access remounts the document with a fresh ticket. */
  readonly onUnauthorized: () => void;
  /** The tab was closed on the server. */
  readonly onGone?: () => void;
  readonly onViewport?: (viewport: { readonly width: number; readonly height: number }) => void;
  readonly onControl?: (control: PreviewStreamControl | null) => void;
  readonly onPictureInPicture?: (state: PreviewPictureInPictureState, detail?: string) => void;
  /** True while frames show, so commands reach the page. Pass a stable function. */
  readonly onStreamingChange?: (streaming: boolean) => void;
  /** The floating player shows a spinner without text or a reconnect button. */
  readonly compact?: boolean;
};

/** Picks files on this device and sends them to the page's open picker; none cancels it. */
async function sendFilesToPage(chooser: PreviewStreamFileChooser, pick: boolean) {
  const body = new FormData();
  if (pick) {
    const { getDocumentAsync } = await import("expo-document-picker");
    const endHandoff = beginForegroundHandoff();
    let result: Awaited<ReturnType<typeof getDocumentAsync>>;
    try {
      result = await getDocumentAsync({ multiple: chooser.multiple, copyToCacheDirectory: true });
    } finally {
      endHandoff();
    }
    for (const asset of result.canceled ? [] : result.assets) {
      // React Native's FormData uploads a file part from its URI.
      body.append("file", {
        uri: asset.uri,
        name: asset.name,
        type: asset.mimeType ?? "application/octet-stream",
      } as unknown as Blob);
    }
  }
  const response = await fetch(chooser.uploadUrl, {
    method: "POST",
    body,
    credentials: chooser.credentials ? "include" : "omit",
  });
  if (!response.ok) throw new Error((await response.text()) || "The upload was refused.");
}

/** The file is on the environment; saving it here goes through the share sheet. */
function offerDownload(download: PreviewStreamDownload) {
  Alert.alert(`Downloaded ${download.fileName}`, undefined, [
    { text: "Not now", style: "cancel" },
    {
      text: "Save or share",
      onPress: () =>
        void downloadAndShareAttachment({
          url: download.url,
          attachment: { name: download.fileName, mimeType: "application/octet-stream" },
          signal: new AbortController().signal,
        }).catch((cause: unknown) =>
          Alert.alert(
            "Could not save the download",
            cause instanceof Error ? cause.message : undefined,
          ),
        ),
    },
  ]);
}

// Consecutive refused tickets before the view stops and offers Reconnect, e.g. a
// session without operate scope.
const MAX_REFUSALS = 3;

export function PreviewStreamWebView(
  props: Omit<PreviewStreamConfiguration, "access" | "viewerKey"> &
    Omit<NativeStreamBridge, "onUnauthorized"> & {
      readonly environmentId: EnvironmentId;
      readonly paused?: boolean;
    },
) {
  const { access, error, refresh } = usePreviewStreamAccess(props.environmentId);
  if (access && !props.paused) {
    return <AuthorizedPreviewStream {...props} access={access} onUnauthorized={refresh} />;
  }
  return (
    <View
      className={
        props.compact
          ? "flex-1 items-center justify-center"
          : "flex-1 items-center justify-center gap-4 px-6"
      }
    >
      {props.compact || !error ? <ActivityIndicator colorClassName="accent-icon" /> : null}
      {!props.compact && (
        <>
          <AppText
            selectable={!!error}
            className={
              error ? "text-center text-sm text-foreground-muted" : "text-sm text-foreground-muted"
            }
          >
            {error || "Connecting to browser..."}
          </AppText>
          {error && (
            <Pressable
              accessibilityRole="button"
              className="rounded-full border border-secondary-border bg-secondary px-6 py-3"
              onPress={refresh}
            >
              <AppText className="text-secondary-foreground">Retry</AppText>
            </Pressable>
          )}
        </>
      )}
    </View>
  );
}

function AuthorizedPreviewStream({
  ref,
  ...props
}: Omit<PreviewStreamConfiguration, "viewerKey"> & NativeStreamBridge) {
  const [attempt, setAttempt] = useState(0);
  const [previousAccess, setPreviousAccess] = useState(props.access);
  // Wait for refreshed access, including cookie credentials with unchanged JSON.
  if (props.access !== previousAccess) {
    setPreviousAccess(props.access);
    setAttempt((current) => current + 1);
  }
  const processRetried = useRef(false);
  const unauthorized = useRef(0);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (refreshTimer.current !== null) clearTimeout(refreshTimer.current);
    },
    [],
  );
  // One name for as long as this view is mounted, across reconnects and fresh tickets.
  const [viewerKey] = useState(uuidv4);
  const configuration = JSON.stringify({
    access: props.access,
    threadId: props.threadId,
    tabId: props.tabId,
    interactive: props.interactive,
    background: props.background,
    viewerKey,
  } satisfies PreviewStreamConfiguration);
  return (
    <PreviewStreamDocumentView
      key={`${attempt}:${configuration}`}
      {...props}
      ref={ref}
      configuration={configuration}
      onUnauthorized={() => {
        // The client has stopped. Restart it with a fresh ticket, backing off between refusals.
        const refusals = ++unauthorized.current;
        if (refusals >= MAX_REFUSALS) return false;
        if (refreshTimer.current !== null) clearTimeout(refreshTimer.current);
        refreshTimer.current = setTimeout(
          () => {
            refreshTimer.current = null;
            props.onUnauthorized();
          },
          refusals === 1 ? 0 : 1_000 * 2 ** (refusals - 1),
        );
        return true;
      }}
      onRetry={() => {
        processRetried.current = false;
        unauthorized.current = 0;
        props.onUnauthorized();
      }}
      onStreaming={() => {
        processRetried.current = false;
        unauthorized.current = 0;
      }}
      onRecoverProcess={() => {
        if (processRetried.current) return false;
        processRetried.current = true;
        setAttempt((current) => current + 1);
        return true;
      }}
    />
  );
}

function PreviewStreamDocumentView({
  ref,
  configuration,
  background,
  compact,
  onUnauthorized,
  onGone,
  onViewport,
  onControl,
  onPictureInPicture,
  onStreamingChange,
  onRetry,
  onStreaming,
  onRecoverProcess,
}: Omit<NativeStreamBridge, "onUnauthorized"> & {
  readonly configuration: string;
  readonly background: string;
  /** False when the view should stop retrying and fail. */
  readonly onUnauthorized: () => boolean;
  readonly onRetry: () => void;
  readonly onStreaming: () => void;
  readonly onRecoverProcess: () => boolean;
}) {
  const webView = useRef<WebView<object>>(null);
  const active = useRef(true);
  const failed = useRef(false);
  const [status, setStatus] = useState<"connecting" | "streaming" | "error">("connecting");
  const [error, setError] = useState<string | null>(null);
  const [gone, setGone] = useState(false);
  const [hostSetup, setHostSetup] = useState<PreviewStreamHostSetup | null>(null);
  const [started, setStarted] = useState(false);
  const [control, setControl] = useState<PreviewStreamControl | null>(null);
  // Only a shared browser reports its surface; ordinary tabs keep the plain control row.
  const [surface, setSurface] = useState<PreviewStreamSurface | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const holdEndsAt = control?.holdExpiresAtMs;
  useEffect(() => {
    if (holdEndsAt === undefined) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [holdEndsAt]);
  const managedControl = surface === null ? null : describeManagedControl(control, now);
  const [promptText, setPromptText] = useState("");
  const [fileChooser, setFileChooser] = useState<PreviewStreamFileChooser | null>(null);
  const answerFileChooser = (pick: boolean) => {
    const chooser = fileChooser;
    if (!chooser) return;
    setFileChooser(null);
    void sendFilesToPage(chooser, pick).catch((cause: unknown) =>
      Alert.alert(
        "Could not send the files to the page",
        cause instanceof Error ? cause.message : undefined,
      ),
    );
  };
  const controlChanged = useEffectEvent((next: PreviewStreamControl | null) => onControl?.(next));
  const command = (input: PreviewStreamInput) =>
    webView.current?.injectJavaScript(
      `window.T3PreviewStream?.command(${JSON.stringify(input)}); true;`,
    );
  const fail = (message: string) => {
    if (!active.current || failed.current) return;
    failed.current = true;
    webView.current?.injectJavaScript("window.T3PreviewStream?.stop(); true;");
    onStreamingChange?.(false);
    setControl(null);
    setFileChooser(null);
    onControl?.(null);
    setError(message);
    setStatus("error");
  };
  // The shared transport owns reconnects once the document acknowledges startup.
  const bootstrapTimedOut = useEffectEvent(() =>
    fail("Browser viewer could not start. Reconnect to try again."),
  );
  useEffect(() => {
    if (started) return;
    const timer = setTimeout(bootstrapTimedOut, 15_000);
    return () => clearTimeout(timer);
  }, [started]);
  const source = useMemo(
    () => ({
      html: previewStreamDocument(configuration, previewStreamScript),
      baseUrl: Platform.OS === "android" ? "https://localhost/" : "file:///",
    }),
    [configuration],
  );
  useImperativeHandle(ref, () => ({
    command,
    togglePictureInPicture: () =>
      webView.current?.injectJavaScript("window.T3PreviewStream?.pictureInPicture(); true;"),
  }));
  useLayoutEffect(() => {
    active.current = true;
    const view = webView.current;
    return () => {
      active.current = false;
      view?.injectJavaScript("window.T3PreviewStream?.stop(); true;");
    };
  }, []);
  useEffect(() => () => onStreamingChange?.(false), [onStreamingChange]);
  useEffect(() => () => controlChanged(null), []);
  const processTerminated = () => {
    if (!active.current || failed.current) return;
    if (!onRecoverProcess()) fail("Browser viewer stopped. Reconnect to try again.");
  };
  return (
    <View className="flex-1" style={{ backgroundColor: background }}>
      {!compact ? (
        <View className="flex-row flex-wrap items-center justify-between gap-2 border-b border-secondary-border px-3 py-2">
          <View className="min-w-0 flex-1">
            <AppText className="text-xs text-foreground-muted">
              {managedControl ? managedControl.label : previewStreamControlLabel(control)}
            </AppText>
            {managedControl?.detail ? (
              <AppText className="text-[11px] text-foreground-muted">
                {managedControl.detail}
              </AppText>
            ) : null}
          </View>
          {surface ? (
            <View className="flex-row gap-2">
              {(["page", "window"] as const).map((choice) => {
                const unavailable = choice === "window" && !surface.window.available;
                return (
                  <Pressable
                    key={choice}
                    accessibilityRole="button"
                    accessibilityLabel={
                      choice === "page" ? "Show the page" : "Show the full window"
                    }
                    accessibilityState={{
                      selected: surface.current === choice,
                      disabled: unavailable,
                    }}
                    disabled={unavailable}
                    className={`rounded-full border px-3 py-2 ${surface.current === choice ? "border-secondary-border bg-secondary" : "border-secondary-border"} ${unavailable ? "opacity-50" : ""}`}
                    onPress={() => command({ type: "surface", surface: choice })}
                  >
                    <AppText className="text-xs text-secondary-foreground">
                      {choice === "page" ? "Page" : "Full window"}
                    </AppText>
                  </Pressable>
                );
              })}
            </View>
          ) : null}
          {managedControl ? (
            managedControl.action ? (
              <Pressable
                accessibilityRole="button"
                className="rounded-full border border-secondary-border bg-secondary px-3 py-2"
                onPress={() =>
                  command({
                    type: managedControl.action === "release" ? "releaseControl" : "takeControl",
                  })
                }
              >
                <AppText className="text-xs text-secondary-foreground">
                  {managedControl.actionLabel}
                </AppText>
              </Pressable>
            ) : null
          ) : control?.canOperate ? (
            <Pressable
              accessibilityRole="button"
              disabled={control.controller === "another-viewer"}
              accessibilityState={{ disabled: control.controller === "another-viewer" }}
              className="rounded-full border border-secondary-border bg-secondary px-3 py-2"
              onPress={() =>
                command({ type: control.controller === "you" ? "releaseControl" : "takeControl" })
              }
            >
              <AppText className="text-xs text-secondary-foreground">
                {control.controller === "you" ? "Release control" : "Take control"}
              </AppText>
            </Pressable>
          ) : null}
          {surface && !surface.window.available && surface.window.reason ? (
            <AppText className="w-full text-[11px] text-foreground-muted">
              Full window: {surface.window.reason}
            </AppText>
          ) : null}
        </View>
      ) : null}
      <WebView<object>
        ref={webView}
        source={source}
        originWhitelist={["*"]}
        scrollEnabled={false}
        bounces={false}
        mixedContentMode="always"
        allowUniversalAccessFromFileURLs
        contentInsetAdjustmentBehavior="never"
        setSupportMultipleWindows={false}
        // Picture in picture plays the canvas as an inline muted video, started from native chrome.
        allowsInlineMediaPlayback
        allowsPictureInPictureMediaPlayback
        mediaPlaybackRequiresUserAction={false}
        style={{ flex: 1, backgroundColor: background }}
        onError={() => fail("Browser viewer could not load. Reconnect to try again.")}
        onHttpError={() => fail("Browser viewer could not load. Reconnect to try again.")}
        onContentProcessDidTerminate={processTerminated}
        onRenderProcessGone={processTerminated}
        onShouldStartLoadWithRequest={(request) =>
          request.url === "about:blank" || request.url === source.baseUrl
        }
        onMessage={(event) => {
          if (!active.current || failed.current) return;
          const message = previewStreamMessage(event.nativeEvent.data);
          if (message === null) return;
          switch (message.type) {
            case "surface":
              setSurface(message);
              return;
            case "control":
              setControl(message);
              setPromptText(message.dialog?.defaultValue ?? "");
              onControl?.(message);
              return;
            case "unauthorized":
              if (!onUnauthorized()) {
                fail("This session can't open the browser stream. Reconnect to try again.");
              }
              return;
            case "gone":
              setGone(true);
              fail("This tab was closed.");
              onGone?.();
              return;
            case "hostSetup":
              setHostSetup({ need: message.need, command: message.command });
              fail(previewStreamHostSetupMessage(message));
              return;
            case "viewport":
              onViewport?.(message);
              return;
            case "clipboard":
              void Clipboard.setStringAsync(message.text).catch(() => undefined);
              return;
            case "download":
              offerDownload(message);
              return;
            case "fileChooser":
              setFileChooser(message.chooser);
              return;
            case "pictureInPicture":
              onPictureInPicture?.(message, message.detail);
              return;
            case "status":
              setStarted(true);
              if (message.status === "error") {
                fail(message.detail ?? "Browser stream failed.");
                return;
              }
              setStatus(message.status);
              if (message.status === "connecting") {
                setControl(null);
                onControl?.(null);
              }
              onStreamingChange?.(message.status === "streaming");
              if (message.status === "streaming") onStreaming();
          }
        }}
      />
      {!compact && fileChooser && control?.controller === "you" ? (
        <View className="absolute inset-x-3 top-16 gap-3 rounded-xl border border-secondary-border bg-secondary p-4">
          <AppText className="text-sm text-secondary-foreground">
            The page asks for {fileChooser.multiple ? "files" : "a file"}.
          </AppText>
          <View className="flex-row justify-end gap-3">
            <Pressable
              accessibilityRole="button"
              className="px-3 py-2"
              onPress={() => answerFileChooser(false)}
            >
              <AppText className="text-secondary-foreground">Cancel</AppText>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              className="px-3 py-2"
              onPress={() => answerFileChooser(true)}
            >
              <AppText className="text-secondary-foreground">
                Choose {fileChooser.multiple ? "files" : "file"}
              </AppText>
            </Pressable>
          </View>
        </View>
      ) : null}
      {!compact && control?.dialog ? (
        <View className="absolute inset-x-3 top-16 gap-3 rounded-xl border border-secondary-border bg-secondary p-4">
          <AppText className="text-sm text-secondary-foreground">{control.dialog.message}</AppText>
          {control.controller === "you" ? (
            <>
              {control.dialog.type === "prompt" ? (
                <TextInput
                  accessibilityLabel="Dialog response"
                  className="rounded-lg border border-secondary-border bg-background px-3 py-2 text-foreground"
                  value={promptText}
                  onChangeText={setPromptText}
                />
              ) : null}
              <View className="flex-row justify-end gap-3">
                <Pressable
                  accessibilityRole="button"
                  className="px-3 py-2"
                  onPress={() => command({ type: "dialog", accept: false })}
                >
                  <AppText className="text-secondary-foreground">Dismiss</AppText>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  className="px-3 py-2"
                  onPress={() =>
                    command({
                      type: "dialog",
                      accept: true,
                      ...(control.dialog?.type === "prompt" ? { promptText } : {}),
                    })
                  }
                >
                  <AppText className="text-secondary-foreground">Accept</AppText>
                </Pressable>
              </View>
            </>
          ) : (
            <AppText className="text-xs text-foreground-muted">Take control to respond.</AppText>
          )}
        </View>
      ) : null}
      {status !== "streaming" ? (
        <View
          className="absolute inset-0 items-center justify-center gap-4 px-6"
          style={{ backgroundColor: background }}
        >
          {status === "connecting" ? <ActivityIndicator colorClassName="accent-icon" /> : null}
          {compact ? null : (
            <AppText
              accessibilityLiveRegion="polite"
              className="text-center text-sm text-foreground-muted"
            >
              {status === "error" ? error : "Connecting to browser..."}
            </AppText>
          )}
          {status === "error" && hostSetup && !compact ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Copy ${hostSetup.command}`}
              className="w-full flex-row items-center gap-2 rounded-xl border border-secondary-border bg-secondary px-4 py-3"
              onPress={() => {
                void Clipboard.setStringAsync(hostSetup.command).catch(() => undefined);
              }}
            >
              <AppText selectable className="flex-1 font-mono text-sm text-secondary-foreground">
                {hostSetup.command}
              </AppText>
              <AppText className="text-xs text-foreground-muted">Copy</AppText>
            </Pressable>
          ) : null}
          {status === "error" && !gone && !compact ? (
            <Pressable
              accessibilityRole="button"
              className="rounded-full border border-secondary-border bg-secondary px-6 py-3"
              onPress={onRetry}
            >
              <AppText className="text-secondary-foreground">
                {hostSetup ? "Try again" : "Reconnect"}
              </AppText>
            </Pressable>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}
