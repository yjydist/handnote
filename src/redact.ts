import { createHash } from "node:crypto";

const secretKeys = /api[-_]?key|authorization|secret|password/i;
const credentialTokenKeys = /^(?:(?:access|refresh|auth|id)[-_]?)?token$/i;
const dataUrl = /^data:[^,]*;base64,/i;
const standardBase64 = /^[A-Za-z0-9+/]+={0,2}$/;
const urlSafeBase64 = /^[A-Za-z0-9_-]+={0,2}$/;
const maximumRecordedString = 64 * 1024;

export interface RedactionOptions {
  secrets?: readonly string[];
}

export interface RedactionContext {
  secretVariants: string[];
  replacement: string;
}

export function redactionContext(options: RedactionOptions): RedactionContext {
  const secretVariants = [
    ...new Set(
      (options.secrets ?? []).flatMap((secret) => {
        if (!secret) return [];
        const encoded = encodeURIComponent(secret);
        const lowercaseEscapes = encoded.replace(/%[0-9A-F]{2}/g, (match) =>
          match.toLowerCase(),
        );
        return [secret, encoded, lowercaseEscapes];
      }),
    ),
  ].sort((left, right) => right.length - left.length);
  const replacement =
    ["[REDACTED]", "[SECRET_REMOVED]", "***", ""].find((candidate) =>
      secretVariants.every((secret) => !candidate.includes(secret)),
    ) ?? "";
  return { secretVariants, replacement };
}

function replaceSecrets(value: string, context: RedactionContext): string {
  let output = value;
  for (const secret of context.secretVariants)
    output = output.replaceAll(secret, context.replacement);
  return output;
}

function isCredentialKey(key: string): boolean {
  return secretKeys.test(key) || credentialTokenKeys.test(key);
}

function looksLikeBase64(value: string): boolean {
  const compact = value.replace(/[\t\n\f\r ]/g, "");
  if (compact.length < 256 || compact.length % 4 === 1) return false;
  return standardBase64.test(compact) || urlSafeBase64.test(compact);
}

function sanitizedParameters(parameters: URLSearchParams): {
  value: string;
  changed: boolean;
} {
  const output = new URLSearchParams();
  let changed = false;
  for (const [name, value] of parameters) {
    if (isCredentialKey(name)) {
      output.append(name, "[REDACTED]");
      changed = true;
    } else if (dataUrl.test(value) || looksLikeBase64(value)) {
      output.append(name, "[BASE64_REDACTED]");
      changed = true;
    } else output.append(name, value);
  }
  return { value: output.toString(), changed };
}

function redactUrl(value: string): string | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  let changed = false;
  if (url.username || url.password) {
    url.username = "[REDACTED]";
    url.password = "[REDACTED]";
    changed = true;
  }
  const query = sanitizedParameters(url.searchParams);
  if (query.changed) {
    url.search = query.value;
    changed = true;
  }
  const rawFragment = url.hash.slice(1);
  const fragmentPrefix = rawFragment.startsWith("?") ? "?" : "";
  const fragmentValue = fragmentPrefix
    ? rawFragment.slice(fragmentPrefix.length)
    : rawFragment;
  if (fragmentValue.includes("=")) {
    const fragment = sanitizedParameters(new URLSearchParams(fragmentValue));
    if (fragment.changed) {
      url.hash = `${fragmentPrefix}${fragment.value}`;
      changed = true;
    }
  }
  return changed ? url.toString() : undefined;
}

function longStringMarker(value: string, context: RedactionContext): string {
  const sha256 = createHash("sha256").update(value).digest("hex");
  return replaceSecrets(
    `[LONG_STRING_REDACTED length=${value.length} sha256=${sha256}]`,
    context,
  );
}

function redactString(value: string, context: RedactionContext): string {
  if (dataUrl.test(value) || looksLikeBase64(value))
    return replaceSecrets("[BASE64_REDACTED]", context);
  const trimmed = value.trimStart();
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    try {
      const nested = JSON.stringify(
        redactValue(JSON.parse(value), "", context),
      );
      return nested.length > maximumRecordedString
        ? longStringMarker(nested, context)
        : nested;
    } catch {}
  }
  if (value.length > maximumRecordedString)
    return longStringMarker(value, context);
  return replaceSecrets(
    value.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]"),
    context,
  );
}

export function redactValue(
  value: unknown,
  key: string,
  context: RedactionContext,
): unknown {
  if (isCredentialKey(key)) return replaceSecrets("[REDACTED]", context);
  if (typeof value === "string") {
    if (dataUrl.test(value) || looksLikeBase64(value))
      return replaceSecrets("[BASE64_REDACTED]", context);
    const sanitizedUrl = redactUrl(value);
    if (sanitizedUrl) return redactString(sanitizedUrl, context);
    return redactString(value, context);
  }
  if (Array.isArray(value))
    return value.map((item) => redactValue(item, "", context));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([name, item]) => [
        name,
        redactValue(item, name, context),
      ]),
    );
  }
  return value;
}

export function redact(
  value: unknown,
  options: RedactionOptions = {},
): unknown {
  return redactValue(value, "", redactionContext(options));
}
