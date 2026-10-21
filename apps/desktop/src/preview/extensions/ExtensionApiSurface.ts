/**
 * The `chrome.*` additions T3 provides to extensions, shared by the main
 * process and the session preload. Dependency-free: the preload runs in every
 * frame of a preview profile, so it must stay tiny.
 */
export const EXTENSION_CALL_CHANNEL = "t3:extension-api-call";
export const EXTENSION_EVENT_CHANNEL = "t3:extension-api-event";

/** Every method the preload installs; the preload is generated from this so the two cannot drift. */
export const EXTENSION_API_SURFACE = {
  tabs: {
    methods: ["get", "getCurrent", "query", "update", "create", "remove", "duplicate", "move", "highlight"],
    events: ["onCreated", "onUpdated", "onActivated", "onRemoved", "onReplaced", "onHighlighted", "onAttached", "onDetached", "onMoved", "onZoomChange"],
    constants: { TAB_ID_NONE: -1 },
  },
  windows: {
    methods: ["get", "getCurrent", "getLastFocused", "getAll", "create", "update", "remove"],
    events: ["onCreated", "onRemoved", "onFocusChanged", "onBoundsChanged"],
    constants: { WINDOW_ID_NONE: -1, WINDOW_ID_CURRENT: -2 },
  },
  webNavigation: {
    methods: ["getFrame", "getAllFrames"],
    events: ["onBeforeNavigate", "onCommitted", "onDOMContentLoaded", "onCompleted", "onErrorOccurred", "onCreatedNavigationTarget", "onReferenceFragmentUpdated", "onHistoryStateUpdated", "onTabReplaced"],
    constants: {},
  },
  action: {
    methods: ["setIcon", "setBadgeText", "getBadgeText", "setBadgeBackgroundColor", "getBadgeBackgroundColor", "setBadgeTextColor", "setTitle", "getTitle", "setPopup", "getPopup", "openPopup", "enable", "disable", "getUserSettings"],
    events: ["onClicked"],
    constants: {},
  },
  contextMenus: {
    methods: ["create", "update", "remove", "removeAll"],
    events: ["onClicked"],
    constants: { ACTION_MENU_TOP_LEVEL_LIMIT: 6 },
  },
  notifications: {
    methods: ["create", "clear", "getPermissionLevel"],
    events: ["onClicked", "onClosed", "onButtonClicked"],
    constants: {},
  },
  permissions: { methods: ["contains", "getAll", "request", "remove"], events: ["onAdded", "onRemoved"], constants: {} },
  commands: { methods: ["getAll"], events: ["onCommand"], constants: {} },
  sidePanel: {
    methods: ["setOptions", "getOptions", "setPanelBehavior", "getPanelBehavior", "open"],
    events: [],
    constants: {},
  },
} as const;
