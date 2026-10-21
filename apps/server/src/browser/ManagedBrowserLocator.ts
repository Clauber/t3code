/**
 * ManagedBrowserLocator - the locators an agent writes, and the part of them a snapshot ref can express.
 *
 * The engine acts on snapshot refs only. `aria-ref=eN`, `role=<role>[name="..."]` and `text=...` are read
 * here, in Playwright's selector syntax, and matched against a fresh snapshot by the adapter; anything else
 * is reported as unsupported with what was not understood, never guessed at.
 *
 * @module ManagedBrowserLocator
 */

const ARIA_REF = /^aria-ref=(.+)$/;

type NamePredicate = {
  readonly value: string;
  /** Whole-string match instead of a substring. */
  readonly exact: boolean;
  readonly caseSensitive: boolean;
};

export type ParsedLocator =
  | { readonly _tag: "ref"; readonly ref: string }
  | { readonly _tag: "role"; readonly role: string; readonly name: NamePredicate | undefined }
  | { readonly _tag: "text"; readonly name: NamePredicate }
  | { readonly _tag: "unsupported"; readonly what: string };

const unsupportedLocator = (what: string): ParsedLocator => ({ _tag: "unsupported", what });

const unquote = (raw: string): { readonly value: string; readonly quoted: boolean } | undefined => {
  const quote = raw[0];
  if ((quote === '"' || quote === "'") && raw.length >= 2 && raw.endsWith(quote)) {
    return { value: raw.slice(1, -1), quoted: true };
  }
  return quote === '"' || quote === "'" ? undefined : { value: raw, quoted: false };
};

const ROLE_ATTRIBUTE = /^\[([a-z-]+)(?:=((?:"[^"]*"|'[^']*'|[^\]\s]+))(?:\s+([is]))?)?\]/;

/**
 * Reads the locators an agent writes in Playwright's selector syntax and keeps only those a ref can
 * express: `aria-ref=eN`, `role=<role>[name="..."]` and `text=...`. Anything else is reported as
 * unsupported with what was not understood, never guessed at.
 */
export const parseLocator = (locator: string): ParsedLocator => {
  const trimmed = locator.trim();
  const ref = ARIA_REF.exec(trimmed);
  if (ref !== null) return { _tag: "ref", ref: ref[1]! };
  if (trimmed.startsWith("role=")) {
    let rest = trimmed.slice("role=".length);
    const role = /^[a-zA-Z][a-zA-Z-]*/.exec(rest)?.[0];
    if (role === undefined) return unsupportedLocator("A role locator without a role");
    rest = rest.slice(role.length);
    let name: NamePredicate | undefined;
    while (rest.length > 0) {
      const attribute = ROLE_ATTRIBUTE.exec(rest);
      if (attribute === null)
        return unsupportedLocator(`The role locator part "${rest.slice(0, 40)}"`);
      const [whole, key, rawValue, flag] = attribute;
      if (key !== "name" || rawValue === undefined) {
        return unsupportedLocator(`The role locator attribute "${key}"`);
      }
      const value = unquote(rawValue);
      if (value === undefined) return unsupportedLocator("A role locator name that is not closed");
      name = { value: value.value, exact: flag === "s", caseSensitive: flag === "s" };
      rest = rest.slice(whole.length);
    }
    return { _tag: "role", role: role.toLowerCase(), name };
  }
  if (trimmed.startsWith("text=")) {
    const raw = trimmed.slice("text=".length);
    if (raw.startsWith("/")) return unsupportedLocator("A regular-expression text locator");
    const value = unquote(raw);
    if (value === undefined || value.value.length === 0) {
      return unsupportedLocator("A text locator that is empty or not closed");
    }
    // Quoted text matches the whole string, unquoted text any part of it, both ignoring case.
    return {
      _tag: "text",
      name: { value: value.value, exact: value.quoted, caseSensitive: false },
    };
  }
  return unsupportedLocator(
    'That locator syntax (use aria-ref=<ref>, role=<role>[name="..."] or text=<text>)',
  );
};

const nameMatches = (predicate: NamePredicate, name: string | undefined) => {
  if (name === undefined) return false;
  const left = predicate.caseSensitive ? name : name.toLowerCase();
  const right = predicate.caseSensitive ? predicate.value : predicate.value.toLowerCase();
  return predicate.exact ? left === right : left.includes(right);
};

export const locatorMatches = (
  locator: Exclude<ParsedLocator, { readonly _tag: "ref" | "unsupported" }>,
  info: { readonly role: string; readonly name?: string | undefined },
) =>
  locator._tag === "role"
    ? info.role.toLowerCase() === locator.role &&
      (locator.name === undefined || nameMatches(locator.name, info.name))
    : nameMatches(locator.name, info.name);
