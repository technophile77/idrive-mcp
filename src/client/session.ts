/**
 * Decodes the payload of the `SES_TOKEN` JWT embedded in a raw `Cookie:`
 * header string, without verifying its signature — shared by every
 * claim-specific extractor below so the JWT-parsing logic (and its
 * "never throw, just return null" failure mode) lives in exactly one place.
 *
 * @param cookieHeader the full `Cookie:` header value, e.g. as configured via
 *   `IDRIVE_COOKIE` — a `;`-separated list of `Name=value` pairs, one of which
 *   is expected to be `SES_TOKEN`.
 * @returns the decoded JWT payload as a plain object, or `null` if
 *   `SES_TOKEN` is absent from the cookie string, isn't a well-formed JWT, or
 *   its payload isn't a JSON object.
 */
function decodeSesTokenPayload(cookieHeader: string): Record<string, unknown> | null {
  const match = cookieHeader.match(/(?:^|;\s*)SES_TOKEN=([^;]+)/);
  if (!match) {
    return null;
  }

  const segments = match[1].split(".");
  if (segments.length < 2) {
    return null;
  }

  try {
    const payloadJson = Buffer.from(segments[1], "base64url").toString("utf8");
    const payload: unknown = JSON.parse(payloadJson);

    if (typeof payload !== "object" || payload === null) {
      return null;
    }

    return payload as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Decodes the `exp` (expiry) claim out of the `SES_TOKEN` JWT embedded in a raw
 * `Cookie:` header string, without verifying its signature — exists so the
 * client can fail fast with a clear "refresh your cookie" error instead of
 * letting a stale session fail cryptically on the actual HTTP call.
 *
 * @param cookieHeader the full `Cookie:` header value, e.g. as configured via
 *   `IDRIVE_COOKIE` — a `;`-separated list of `Name=value` pairs, one of which
 *   is expected to be `SES_TOKEN`.
 * @returns the token's expiry as a `Date`, or `null` if `SES_TOKEN` is absent
 *   from the cookie string, isn't a well-formed JWT, or its payload has no
 *   numeric `exp` claim. Never throws — the exact cookie format on the wire
 *   isn't guaranteed, so malformed input is treated as "unknown" rather than
 *   an error.
 * @example
 * ```ts
 * const cookie =
 *   "JSESSIONID=abc123; " +
 *   "SES_TOKEN=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9." +
 *   "eyJ1c2VyX2lkIjoxMjM0NSwiaWQiOjEsInN1YiI6InVzZXJAZXhhbXBsZS5jb20iLCJpYXQiOjE3MDAwMDAwMDAsImV4cCI6MTcwMDA4NjQwMH0." +
 *   "fakesignature";
 * extractSesTokenExpiry(cookie); // => Date (2023-11-15T20:53:20.000Z)
 * ```
 * @see isSessionExpired
 */
export function extractSesTokenExpiry(cookieHeader: string): Date | null {
  const payload = decodeSesTokenPayload(cookieHeader);
  if (payload === null || typeof payload.exp !== "number") {
    return null;
  }

  return new Date(payload.exp * 1000);
}

/**
 * Decodes the `sub` (subject) claim out of the `SES_TOKEN` JWT embedded in a
 * raw `Cookie:` header string — this claim is the account's own email
 * address (confirmed against a live session capture, see the
 * `getListDevicesForSub` example in `docs/api-map.md`), so tools that need
 * the account email (e.g. as the `username` field for
 * `getListDevicesForSub`) can derive it from the configured session instead
 * of requiring a separate, easily-stale config value.
 *
 * @param cookieHeader the full `Cookie:` header value, in the same format
 *   accepted by {@link extractSesTokenExpiry}.
 * @returns the account email, or `null` if `SES_TOKEN` is absent from the
 *   cookie string, isn't a well-formed JWT, or its payload has no string
 *   `sub` claim. Never throws, for the same reason as
 *   {@link extractSesTokenExpiry}.
 * @example
 * ```ts
 * const cookie =
 *   "JSESSIONID=abc123; " +
 *   "SES_TOKEN=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9." +
 *   "eyJ1c2VyX2lkIjoxMjM0NSwiaWQiOjEsInN1YiI6InVzZXJAZXhhbXBsZS5jb20iLCJpYXQiOjE3MDAwMDAwMDAsImV4cCI6MTcwMDA4NjQwMH0." +
 *   "fakesignature";
 * extractAccountEmail(cookie); // => "user@example.com"
 * ```
 */
export function extractAccountEmail(cookieHeader: string): string | null {
  const payload = decodeSesTokenPayload(cookieHeader);
  if (payload === null || typeof payload.sub !== "string") {
    return null;
  }

  return payload.sub;
}

/**
 * Checks whether the `SES_TOKEN` embedded in a raw `Cookie:` header has
 * already expired, so callers can refuse a doomed request before it hits the
 * network.
 *
 * @param cookieHeader the full `Cookie:` header value, in the same format
 *   accepted by {@link extractSesTokenExpiry}.
 * @returns `true` only when the token's `exp` claim is a known, past
 *   timestamp. Returns `false` both when the session is still valid *and*
 *   when expiry can't be determined (missing/malformed `SES_TOKEN`) — in the
 *   "can't tell" case we assume valid and let the real HTTP call surface any
 *   actual auth failure.
 * @example
 * ```ts
 * const expiredCookie =
 *   "SES_TOKEN=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9." +
 *   "eyJ1c2VyX2lkIjoxMjM0NSwiaWQiOjEsInN1YiI6InVzZXJAZXhhbXBsZS5jb20iLCJpYXQiOjE3MDAwMDAwMDAsImV4cCI6MTcwMDA4NjQwMH0." +
 *   "fakesignature";
 * isSessionExpired(expiredCookie); // => true (exp is in the past)
 * ```
 * @see extractSesTokenExpiry
 */
export function isSessionExpired(cookieHeader: string): boolean {
  const expiry = extractSesTokenExpiry(cookieHeader);
  if (expiry === null) {
    return false;
  }

  return expiry.getTime() < Date.now();
}

/**
 * Extracts the `EVS_SERVER` value from a raw `Cookie:` header string — the
 * hostname of the per-account satellite host (e.g. `evsweb5187.idrive.com`)
 * that the `/idrive/home` file browser's `evs/browseFolder`/`evs/getThumbnail`
 * endpoints run on (see the "Second app surface" section of
 * `docs/api-map.md`). Unlike `SES_TOKEN`, `EVS_SERVER` is a plain cookie
 * value, not JWT-encoded, so this reads it directly out of the `;`-separated
 * cookie string rather than going through {@link extractSesTokenExpiry}'s
 * JWT-decoding path.
 *
 * @param cookieHeader the full `Cookie:` header value, e.g. as configured via
 *   `IDRIVE_COOKIE` — a `;`-separated list of `Name=value` pairs, one of which
 *   is expected to be `EVS_SERVER`.
 * @returns the EVS host name, or `null` if `EVS_SERVER` is absent from the
 *   cookie string or the cookie string itself is empty. Never throws — the
 *   presence of this cookie isn't guaranteed on every session, so a missing
 *   value is treated as "unknown" rather than an error.
 * @example
 * ```ts
 * const cookie =
 *   "JSESSIONID=abc123; " +
 *   "EVS_SERVER=evsweb5187.idrive.com; " +
 *   "SES_TOKEN=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyQGV4YW1wbGUuY29tIn0.sig";
 * extractEvsServerHost(cookie); // => "evsweb5187.idrive.com"
 * ```
 */
export function extractEvsServerHost(cookieHeader: string): string | null {
  const match = cookieHeader.match(/(?:^|;\s*)EVS_SERVER=([^;]+)/);
  if (!match) {
    return null;
  }

  return match[1];
}
