/** Menu action ids shared by every client so labels and handlers line up across surfaces. */
export type MediaActionId =
  | "copy-full-path"
  | "copy-relative-path"
  | "copy-url"
  | "open-file"
  | "save"
  | "copy-image"
  /** Client-surface only: offered when the media source carries an `onHide` callback. */
  | "hide-image";
