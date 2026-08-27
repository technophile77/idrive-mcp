import { extractAccountEmail, extractEvsServerHost, isSessionExpired } from "./session.js";

const IDRIVE_ORIGIN = "https://www.idrive.com";

/** `Referer` header value used for calls to a per-account EVS satellite host, distinct from the idriveent console's `Referer` (see `docs/api-map.md`'s "Second app surface" section). */
const EVS_REFERER = "https://www.idrive.com/";

/** Static User-Agent copied verbatim from a captured browser session against idrive.com. */
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36";

/**
 * Thrown when a request is about to be sent with a `SES_TOKEN` that has
 * already expired, so tool code can catch it and surface a clean
 * "refresh your session" message instead of a cryptic downstream HTTP
 * failure.
 *
 * @example
 * ```ts
 * try {
 *   await client.request("/idriveent//remote/getListDevicesForSub", { json: "yes", username: "user@example.com" });
 * } catch (err) {
 *   if (err instanceof SessionExpiredError) {
 *     console.error(err.message); // tells the user to refresh IDRIVE_COOKIE
 *   }
 * }
 * ```
 */
export class SessionExpiredError extends Error {
  constructor() {
    super(
      "iDrive session has expired (the SES_TOKEN cookie's exp claim is in the past). " +
        "Refresh IDRIVE_COOKIE with a new Cookie header value from a logged-in idrive.com browser session.",
    );
    this.name = "SessionExpiredError";
  }
}

/**
 * Thrown when an `/evs/*` request is about to be sent but the configured
 * session cookie has no `EVS_SERVER` value, so the EVS satellite host can't
 * be determined. Distinct from {@link SessionExpiredError}: the cookie isn't
 * stale here, it's just missing a field, so tool code needs a different
 * message to avoid telling the user to do something that won't fix it.
 *
 * @example
 * ```ts
 * try {
 *   await client.requestEvs("/evs/browseFolder", { p: "//C", json: "yes", device_id: "D0163..." });
 * } catch (err) {
 *   if (err instanceof MissingEvsServerError) {
 *     console.error(err.message); // tells the user to re-copy the full Cookie header
 *   }
 * }
 * ```
 */
export class MissingEvsServerError extends Error {
  constructor() {
    super(
      "Could not determine the EVS satellite host from the configured session " +
        "(no EVS_SERVER value in the Cookie header). Re-copy the full Cookie header " +
        "(all fields, not just SES_TOKEN) from a logged-in idrive.com browser session.",
    );
    this.name = "MissingEvsServerError";
  }
}

/**
 * Thrown when the `EVSID` bootstrap handshake (`getnewserver` →
 * `tokenLogin`, see `docs/api-map.md`'s "EVSID: how the EVS session is
 * actually established" section) fails for a reason other than an expired
 * `www.idrive.com` session — e.g. `getnewserver`'s response text doesn't
 * contain the expected `$`-separated URL/host pair, the `tokenLogin` request
 * itself fails, or its response carries no `Set-Cookie: EVSID=...` header.
 * Distinct from {@link SessionExpiredError}: that one fires first, before any
 * bootstrap attempt, whenever the configured session is already known to be
 * stale — this one means the session looked valid but the handshake still
 * didn't produce a usable `EVSID`, which usually means iDrive changed the
 * handshake shape rather than that `IDRIVE_COOKIE` needs refreshing.
 *
 * @example
 * ```ts
 * try {
 *   await client.requestEvs("/evs/listDevices", { json: "yes" });
 * } catch (err) {
 *   if (err instanceof EvsBootstrapError) {
 *     console.error(err.message); // explains the bootstrap step that failed
 *   }
 * }
 * ```
 */
export class EvsBootstrapError extends Error {
  constructor(reason: string) {
    super(
      `Failed to establish an EVS session (EVSID) needed for /evs/* calls: ${reason} ` +
        "This usually means iDrive's getnewserver/tokenLogin handshake shape has changed " +
        'rather than that IDRIVE_COOKIE is stale — see docs/api-map.md\'s "EVSID: how the ' +
        'EVS session is actually established" section.',
    );
    this.name = "EvsBootstrapError";
  }
}

/**
 * Builds the header set every request to idrive.com needs, mimicking a real
 * browser session so requests aren't rejected as non-browser traffic. The
 * `Referer` value differs between the `idriveent` console and the EVS
 * satellite hosts (see `docs/api-map.md`'s "Second app surface" section), so
 * it's a parameter rather than hardcoded.
 *
 * @param cookie the full `Cookie:` header value for the authenticated session.
 * @param referer the `Referer` header value to send, e.g. `https://www.idrive.com/idrive/home`
 *   for `idriveent`/`idrive/home` calls or `https://www.idrive.com/` for EVS-host calls.
 * @returns a plain header map ready to pass to `fetch`.
 */
function buildDefaultHeaders(cookie: string, referer: string): Record<string, string> {
  return {
    Accept: "*/*",
    "X-Requested-With": "XMLHttpRequest",
    Origin: IDRIVE_ORIGIN,
    Referer: referer,
    Cookie: cookie,
    "User-Agent": USER_AGENT,
  };
}

/**
 * Parses an iDrive API response body, tolerating the API's habit of
 * declaring `Content-Type: text/plain` on bodies that are actually JSON
 * text.
 *
 * @param response the raw `fetch` response to read and parse.
 * @returns the parsed JSON value, or the raw response text if it isn't
 *   valid JSON.
 */
async function parseResponseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * Builds the header set an already-bootstrapped `EVSID` needs for calls to
 * an EVS satellite host, in place of the `www.idrive.com` cookie — per
 * `docs/api-map.md`'s "EVSID: how the EVS session is actually established"
 * section, the EVS host only ever needs the `EVSID` cookie by itself, not
 * any of the `www.idrive.com` session cookies.
 *
 * @param evsid the bootstrapped `EVSID` cookie value (never logged — see
 *   this project's standing rule against logging secrets).
 * @param referer the `Referer` header value to send, matching
 *   {@link buildDefaultHeaders}'s parameter of the same name.
 * @returns a plain header map ready to pass to `fetch`.
 */
function buildEvsHeaders(evsid: string, referer: string): Record<string, string> {
  return {
    Accept: "*/*",
    "X-Requested-With": "XMLHttpRequest",
    Origin: IDRIVE_ORIGIN,
    Referer: referer,
    Cookie: `EVSID=${evsid}`,
    "User-Agent": USER_AGENT,
  };
}

/**
 * Splits the raw response text of `POST /idrive/home/getnewserver` into the
 * `tokenLogin` URL and bare EVS host it packs together, so
 * {@link IdriveClient}'s EVSID bootstrap doesn't inline this string-parsing
 * logic — kept as a standalone pure function so it can be unit-tested with a
 * fabricated response string, without a real session cookie. See
 * `docs/api-map.md`'s "EVSID: how the EVS session is actually established"
 * section for the format this reverse-engineers.
 *
 * @param responseText the raw response body of `getnewserver`, shaped like
 *   `\r\n\r\nhttps://<evs-host>/evs/tokenLogin?token=...&sid=...$<evs-host>`.
 * @returns the `tokenLogin` URL and bare EVS host, or `null` if
 *   `responseText` doesn't contain the expected `$`-separated pair (e.g.
 *   iDrive changed the response shape).
 * @example
 * ```ts
 * parseGetNewServerResponse(
 *   "\r\n\r\nhttps://evsweb5187.idrive.com/evs/tokenLogin?token=abc&sid=def&rm=null&content_type=img$evsweb5187.idrive.com",
 * );
 * // => {
 * //   tokenLoginUrl: "https://evsweb5187.idrive.com/evs/tokenLogin?token=abc&sid=def&rm=null&content_type=img",
 * //   evsHost: "evsweb5187.idrive.com",
 * // }
 * ```
 */
export function parseGetNewServerResponse(responseText: string): { tokenLoginUrl: string; evsHost: string } | null {
  const trimmed = responseText.trim();
  const separatorIndex = trimmed.lastIndexOf("$");
  if (separatorIndex === -1) {
    return null;
  }

  const tokenLoginUrl = trimmed.slice(0, separatorIndex).trim();
  const evsHost = trimmed.slice(separatorIndex + 1).trim();
  if (tokenLoginUrl === "" || evsHost === "") {
    return null;
  }

  return { tokenLoginUrl, evsHost };
}

/**
 * Checks whether a parsed `/evs/*` response body is the API's "stale or
 * missing `EVSID`" error shape (`{"message":"ERROR","desc":"INVALID
 * PARAMETERS"}`, see `docs/api-map.md`), so {@link IdriveClient} can tell
 * this specific failure apart from a genuine `/evs/*` business error (e.g. a
 * bad `device_id`) and retry once with a freshly-minted `EVSID` instead of
 * surfacing a confusing error to the caller.
 *
 * @param body the parsed JSON response body from an `/evs/*` call.
 * @returns `true` only when `body` matches the exact `INVALID PARAMETERS`
 *   shape.
 */
function isInvalidEvsidResponse(body: unknown): boolean {
  return (
    typeof body === "object" &&
    body !== null &&
    (body as { message?: unknown }).message === "ERROR" &&
    (body as { desc?: unknown }).desc === "INVALID PARAMETERS"
  );
}

/**
 * Best-effort check for the "stale or missing `EVSID`" error shape (see
 * {@link isInvalidEvsidResponse}) in a raw response body, for `/evs/*`
 * endpoints that return arbitrary bytes rather than a `Content-Type` the
 * client can trust (e.g. `evs/downloadFile`, `evs/getThumbnail`, per
 * `docs/api-map.md`). This is a heuristic, not a certainty: a small binary
 * file whose bytes happen to decode as that exact JSON shape would be
 * misdiagnosed as an invalid-EVSID response and trigger one harmless retry.
 * The size cap keeps this cheap and avoids attempting to UTF-8-decode large
 * binary payloads.
 *
 * @param data the raw response bytes.
 * @returns `true` when `data` is short enough to plausibly be the error
 *   response and decodes to that exact JSON shape.
 */
function looksLikeInvalidEvsidResponse(data: Buffer): boolean {
  if (data.byteLength > 256) {
    return false;
  }

  try {
    return isInvalidEvsidResponse(JSON.parse(data.toString("utf8")));
  } catch {
    return false;
  }
}

/**
 * Low-level HTTP client shared by every iDrive MCP tool. Wraps the
 * form-encoded POST and plain GET request shapes documented in
 * `docs/api-map.md`, applies the browser-mimicking headers iDrive expects on
 * every call, and fails fast on an expired session instead of letting a
 * stale cookie produce a confusing HTTP error deep in tool code.
 *
 * @example
 * ```ts
 * const client = new IdriveClient(loadConfig().cookie);
 * const devices = await client.request("/idriveent//remote/getListDevicesForSub", {
 *   json: "yes",
 *   username: "user@example.com",
 * });
 * ```
 */
export class IdriveClient {
  private readonly cookie: string;

  /**
   * In-memory cache of the most recently minted `EVSID` and which EVS host
   * it's valid for, so the `getnewserver`→`tokenLogin` handshake (see
   * `docs/api-map.md`) only runs once per host per process instead of on
   * every `/evs/*` call. `null` until the first `/evs/*` call bootstraps it.
   */
  private evsidCache: { host: string; evsid: string } | null = null;

  /**
   * Creates a client bound to a single authenticated session cookie.
   *
   * @param cookie the full `Cookie:` header value from a logged-in
   *   idrive.com browser session (as loaded from `IDRIVE_COOKIE` — see
   *   {@link loadConfig}).
   */
  constructor(cookie: string) {
    this.cookie = cookie;
  }

  /**
   * Guards a request against being sent with an already-expired session.
   *
   * @throws {SessionExpiredError} if the configured cookie's `SES_TOKEN` has
   *   a past `exp` claim.
   */
  private assertSessionValid(): void {
    if (isSessionExpired(this.cookie)) {
      throw new SessionExpiredError();
    }
  }

  /**
   * Derives the authenticated account's email address from the configured
   * session cookie, so tool code that needs it (e.g. the `username` field on
   * `getListDevicesForSub`) doesn't need its own copy of the cookie or its
   * own JWT-parsing logic — it stays behind this client, same as the cookie
   * itself.
   *
   * @returns the account email, or `null` if it can't be determined from the
   *   configured cookie (missing or malformed `SES_TOKEN`).
   * @example
   * ```ts
   * const client = new IdriveClient(loadConfig().cookie);
   * client.getAccountEmail(); // => "user@example.com"
   * ```
   */
  getAccountEmail(): string | null {
    return extractAccountEmail(this.cookie);
  }

  /**
   * Sends a form-encoded `POST` to an iDrive API endpoint — the shape used
   * by almost every endpoint in `docs/api-map.md`.
   *
   * @param path the endpoint path, e.g. `/idriveent//remote/getListDevicesForSub`
   *   or `/idriveent/remote/getRestoreData` — always starting with `/idrive/...`
   *   or `/idriveent/...`.
   * @param formFields the form fields to send as the request body; values are
   *   URL-encoded automatically (some field values are themselves JSON
   *   strings, per the API's own convention — pass them pre-stringified).
   * @returns the parsed JSON response body, or the raw text if the body
   *   isn't valid JSON.
   * @throws {SessionExpiredError} if the configured session has already
   *   expired.
   * @example
   * ```ts
   * // Mirrors the confirmed getRestoreData call in docs/api-map.md
   * const listing = await client.request("/idriveent/remote/getRestoreData", {
   *   id: "/",
   *   macType: "win",
   *   selUser: "user@example.com",
   *   from: "",
   *   toDate: "NaN/NaN/NaN NaN:NaN:NaN",
   *   device_id: "D01637267159000960219",
   * });
   * ```
   */
  async request(path: string, formFields: Record<string, string>): Promise<unknown> {
    this.assertSessionValid();

    const response = await fetch(`${IDRIVE_ORIGIN}${path}`, {
      method: "POST",
      headers: {
        ...buildDefaultHeaders(this.cookie, `${IDRIVE_ORIGIN}/idrive/home`),
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      },
      body: new URLSearchParams(formFields),
    });

    return parseResponseBody(response);
  }

  /**
   * Sends a `GET` to an iDrive API endpoint — used by the handful of
   * plain-GET endpoints noted in `docs/api-map.md` (e.g. feature flags,
   * dashboard data).
   *
   * @param path the endpoint path, e.g. `/idrive/home/products/account/exists`.
   * @param query optional query-string parameters to append to the URL.
   * @returns the parsed JSON response body, or the raw text if the body
   *   isn't valid JSON.
   * @throws {SessionExpiredError} if the configured session has already
   *   expired.
   * @example
   * ```ts
   * // Mirrors the confirmed GET /idrive/home/products/account/exists call
   * const features = await client.get("/idrive/home/products/account/exists");
   * // => { showRPCLHS: true, showE2LHS: true, show360LHS: true }
   * ```
   */
  async get(path: string, query?: Record<string, string>): Promise<unknown> {
    this.assertSessionValid();

    const url = new URL(`${IDRIVE_ORIGIN}${path}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      url.searchParams.set(key, value);
    }

    const response = await fetch(url, {
      method: "GET",
      headers: buildDefaultHeaders(this.cookie, `${IDRIVE_ORIGIN}/idrive/home`),
    });

    return parseResponseBody(response);
  }

  /**
   * Resolves the EVS host from the configured session cookie, or throws a
   * clear error naming what's missing — shared by {@link requestEvs} and
   * {@link getEvs} so both fail the same way when the cookie doesn't carry an
   * `EVS_SERVER` value.
   *
   * @returns the EVS host name (e.g. `evsweb5187.idrive.com`).
   * @throws {MissingEvsServerError} if the configured cookie has no
   *   `EVS_SERVER` value.
   */
  private requireEvsServerHost(): string {
    const host = this.getEvsServerHost();
    if (host === null) {
      throw new MissingEvsServerError();
    }

    return host;
  }

  /**
   * Derives the per-account EVS satellite host (e.g. `evsweb5187.idrive.com`)
   * from the configured session cookie, so tool code that needs to call
   * `/evs/*` endpoints doesn't need its own cookie-parsing logic — same
   * pattern as {@link getAccountEmail}.
   *
   * @returns the EVS host name, or `null` if it can't be determined from the
   *   configured cookie (no `EVS_SERVER` value present).
   * @example
   * ```ts
   * const client = new IdriveClient(loadConfig().cookie);
   * client.getEvsServerHost(); // => "evsweb5187.idrive.com"
   * ```
   */
  getEvsServerHost(): string | null {
    return extractEvsServerHost(this.cookie);
  }

  /**
   * Returns a valid `EVSID` for `evsHost`, minting one via {@link bootstrapEvsid}
   * on first use (or after {@link invalidateEvsid} clears a stale one) and
   * caching it thereafter — so the `getnewserver`→`tokenLogin` handshake only
   * runs once per host per process instead of on every `/evs/*` call. Exists
   * because the fix in `docs/api-map.md`'s "EVSID: how the EVS session is
   * actually established" section requires this bootstrap before any
   * `/evs/*` call can succeed, but re-running it every call would be wasteful
   * and slow.
   *
   * @param evsHost the EVS host to get a valid `EVSID` for, as resolved by
   *   {@link requireEvsServerHost}.
   * @returns the cached or freshly-minted `EVSID` cookie value.
   * @throws {EvsBootstrapError} if minting a new `EVSID` was needed and the
   *   handshake failed.
   */
  private async getEvsid(evsHost: string): Promise<string> {
    if (this.evsidCache !== null && this.evsidCache.host === evsHost) {
      return this.evsidCache.evsid;
    }

    const evsid = await this.bootstrapEvsid(evsHost);
    this.evsidCache = { host: evsHost, evsid };
    return evsid;
  }

  /**
   * Clears the cached `EVSID` for `evsHost` if one is cached, so the next
   * {@link getEvsid} call mints a fresh one — called when an `/evs/*`
   * response comes back in the `INVALID PARAMETERS` shape that means the
   * cached `EVSID` has gone stale (see {@link isInvalidEvsidResponse}).
   *
   * @param evsHost the EVS host whose cached `EVSID`, if any, should be
   *   dropped.
   */
  private invalidateEvsid(evsHost: string): void {
    if (this.evsidCache !== null && this.evsidCache.host === evsHost) {
      this.evsidCache = null;
    }
  }

  /**
   * Runs the two-step `EVSID` handshake documented in `docs/api-map.md`'s
   * "EVSID: how the EVS session is actually established" section: first
   * `POST /idrive/home/getnewserver` (using the configured `www.idrive.com`
   * session cookie) to obtain a one-time `tokenLogin` URL, then `GET` that
   * URL (no cookies needed) and read the `EVSID` value off its `Set-Cookie`
   * response header. Exists because the EVS satellite host doesn't accept
   * the `www.idrive.com` session cookie directly — every `/evs/*` call needs
   * its own `EVSID` instead.
   *
   * @param evsHost the EVS host being bootstrapped for, used only to
   *   sanity-check that `getnewserver`'s response names the same host the
   *   caller expected (a mismatch would mean the `EVS_SERVER` cookie is
   *   stale relative to the account's actual assigned server).
   * @returns a freshly-minted `EVSID` cookie value (never logged — see this
   *   project's standing rule against logging secrets).
   * @throws {EvsBootstrapError} if `getnewserver`'s response can't be parsed
   *   into a `tokenLogin` URL/host pair, the `tokenLogin` request itself
   *   fails, or its response carries no `Set-Cookie: EVSID=...` header.
   * @see parseGetNewServerResponse
   */
  private async bootstrapEvsid(evsHost: string): Promise<string> {
    let getNewServerResponseText: string;
    try {
      const getNewServerResponse = await fetch(`${IDRIVE_ORIGIN}/idrive/home/getnewserver`, {
        method: "POST",
        headers: buildDefaultHeaders(this.cookie, `${IDRIVE_ORIGIN}/idrive/home`),
      });
      getNewServerResponseText = await getNewServerResponse.text();
    } catch (error) {
      throw new EvsBootstrapError(
        `POST /idrive/home/getnewserver failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const parsed = parseGetNewServerResponse(getNewServerResponseText);
    if (parsed === null) {
      throw new EvsBootstrapError(
        `couldn't find a "$"-separated tokenLogin-URL/host pair in getnewserver's response ` +
          `(got ${JSON.stringify(getNewServerResponseText)}).`,
      );
    }

    let tokenLoginResponse: Response;
    try {
      tokenLoginResponse = await fetch(parsed.tokenLoginUrl, { method: "GET" });
    } catch (error) {
      throw new EvsBootstrapError(
        `the tokenLogin request failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const evsidCookie = tokenLoginResponse.headers
      .getSetCookie()
      .find((setCookie) => setCookie.startsWith("EVSID="));
    if (evsidCookie === undefined) {
      throw new EvsBootstrapError(
        "the tokenLogin response carried no Set-Cookie: EVSID=... header (checked against " +
          `${parsed.evsHost}).`,
      );
    }

    const evsid = evsidCookie.slice("EVSID=".length).split(";")[0].trim();
    if (evsid === "") {
      throw new EvsBootstrapError("the tokenLogin response's EVSID cookie value was empty.");
    }

    return evsid;
  }

  /**
   * Sends a form-encoded `POST` to `path` on `evsHost` authenticated with
   * `evsid`, without parsing the response — the shared low-level primitive
   * behind {@link requestEvs}, {@link requestEvsWithParams}, and
   * {@link requestEvsRaw}, which differ only in how they build the request
   * body and interpret the response (parsed JSON/text vs. raw bytes). Takes
   * a `URLSearchParams` body (rather than a plain field object) so callers
   * that need repeated keys — e.g. multiple `p` fields for a batch
   * delete/restore, see {@link requestEvsWithParams} — can pass them via
   * repeated `URLSearchParams.append` calls, which a plain
   * `Record<string, string>` can't represent.
   *
   * @param evsHost the EVS host to send the request to.
   * @param evsid the `EVSID` cookie value to authenticate with.
   * @param path the endpoint path, e.g. `/evs/browseFolder`.
   * @param params the form body to send, already built as `URLSearchParams`.
   * @returns the raw, unread `fetch` `Response`.
   */
  private postToEvsHost(evsHost: string, evsid: string, path: string, params: URLSearchParams): Promise<Response> {
    return fetch(`https://${evsHost}${path}`, {
      method: "POST",
      headers: {
        ...buildEvsHeaders(evsid, EVS_REFERER),
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      },
      body: params,
    });
  }

  /**
   * Sends a form-encoded `POST` to an endpoint on the account's EVS
   * satellite host — the `/evs/*` counterpart to {@link request}, used by the
   * `/idrive/home` file browser surface documented in `docs/api-map.md`'s
   * "Second app surface" section. Transparently bootstraps (and caches) the
   * `EVSID` this host requires — see {@link getEvsid} — and retries once with
   * a freshly-minted `EVSID` if the response comes back in the
   * "stale/missing EVSID" shape (see {@link isInvalidEvsidResponse}).
   *
   * @param path the endpoint path, e.g. `/evs/browseFolder` — always starting
   *   with `/evs/...`.
   * @param formFields the form fields to send as the request body; values are
   *   URL-encoded automatically.
   * @returns the parsed JSON response body, or the raw text if the body isn't
   *   valid JSON.
   * @throws {SessionExpiredError} if the configured session has already
   *   expired.
   * @throws {MissingEvsServerError} if the configured cookie has no
   *   `EVS_SERVER` value, so the EVS host can't be determined.
   * @throws {EvsBootstrapError} if the `EVSID` handshake failed and no cached
   *   `EVSID` was usable.
   * @example
   * ```ts
   * // Mirrors the corrected evs/browseFolder call in docs/api-map.md
   * const listing = await client.requestEvs("/evs/browseFolder", {
   *   p: "/C",
   *   json: "yes",
   *   devices: "yes",
   *   device_id: "D01637267159000960219",
   * });
   * ```
   */
  async requestEvs(path: string, formFields: Record<string, string>): Promise<unknown> {
    return this.requestEvsWithParams(path, new URLSearchParams(formFields));
  }

  /**
   * Sends a form-encoded `POST` to an endpoint on the account's EVS
   * satellite host, same as {@link requestEvs}, but takes a pre-built
   * `URLSearchParams` body instead of a flat field object — the primitive
   * `requestEvs` itself delegates to. Exists for endpoints that need a
   * repeated field key (e.g. `evs/v1/deleteFile` and
   * `evs/putBackFromTrash`'s repeatable `p` field, one per path, per
   * `docs/api-map.md`'s "Live mutation testing" section), which a
   * `Record<string, string>` can't represent since object keys are unique.
   *
   * @param path the endpoint path, e.g. `/evs/v1/deleteFile`.
   * @param params the form body to send; build it with repeated
   *   `URLSearchParams.append(key, value)` calls for any repeated field.
   * @returns the parsed JSON response body, or the raw text if the body
   *   isn't valid JSON.
   * @throws {SessionExpiredError} if the configured session has already
   *   expired.
   * @throws {MissingEvsServerError} if the configured cookie has no
   *   `EVS_SERVER` value, so the EVS host can't be determined.
   * @throws {EvsBootstrapError} if the `EVSID` handshake failed and no cached
   *   `EVSID` was usable.
   * @example
   * ```ts
   * // Mirrors the confirmed evs/v1/deleteFile call in docs/api-map.md
   * const params = new URLSearchParams({ trash: "yes", json: "yes", device_id: "D01637267159000960219" });
   * params.append("p", "/C/MCP_API_TEST_FOLDER");
   * params.append("p", "/C/MCP_API_TEST_FOLDER/notes.txt");
   * const result = await client.requestEvsWithParams("/evs/v1/deleteFile", params);
   * // => { message: "SUCCESS", contents: [{ path: "...", result: "SUCCESS" }, ...] }
   * ```
   */
  async requestEvsWithParams(path: string, params: URLSearchParams): Promise<unknown> {
    this.assertSessionValid();
    const evsHost = this.requireEvsServerHost();

    const evsid = await this.getEvsid(evsHost);
    const body = await parseResponseBody(await this.postToEvsHost(evsHost, evsid, path, params));
    if (!isInvalidEvsidResponse(body)) {
      return body;
    }

    this.invalidateEvsid(evsHost);
    const retryEvsid = await this.getEvsid(evsHost);
    return parseResponseBody(await this.postToEvsHost(evsHost, retryEvsid, path, params));
  }

  /**
   * Sends a form-encoded `POST` to an endpoint on the account's EVS
   * satellite host and returns the raw, unparsed response bytes — the
   * counterpart to {@link requestEvs} for `/evs/*` endpoints whose response
   * body is the actual payload rather than a JSON envelope (e.g.
   * `evs/downloadFile`, see `docs/api-map.md`), so callers don't have binary
   * file content mangled by {@link parseResponseBody}'s text/JSON parsing
   * and re-encoding. Same `EVSID` bootstrap/caching/retry behavior as
   * {@link requestEvs}.
   *
   * @param path the endpoint path, e.g. `/evs/downloadFile`.
   * @param formFields the form fields to send as the request body.
   * @returns the raw response body bytes, unmodified.
   * @throws {SessionExpiredError} if the configured session has already
   *   expired.
   * @throws {MissingEvsServerError} if the configured cookie has no
   *   `EVS_SERVER` value, so the EVS host can't be determined.
   * @throws {EvsBootstrapError} if the `EVSID` handshake failed and no cached
   *   `EVSID` was usable.
   * @example
   * ```ts
   * // Mirrors the confirmed evs/downloadFile call in docs/api-map.md
   * const file = await client.requestEvsRaw("/evs/downloadFile", {
   *   p: "/C/AMD/Support/licensePLK.txt",
   *   json: "yes",
   *   device_id: "D01637267159000960219",
   * });
   * // => Buffer<...> (the file's raw content)
   * ```
   */
  async requestEvsRaw(path: string, formFields: Record<string, string>): Promise<Buffer> {
    this.assertSessionValid();
    const evsHost = this.requireEvsServerHost();
    const params = new URLSearchParams(formFields);

    const evsid = await this.getEvsid(evsHost);
    const data = Buffer.from(await (await this.postToEvsHost(evsHost, evsid, path, params)).arrayBuffer());
    if (!looksLikeInvalidEvsidResponse(data)) {
      return data;
    }

    this.invalidateEvsid(evsHost);
    const retryEvsid = await this.getEvsid(evsHost);
    return Buffer.from(await (await this.postToEvsHost(evsHost, retryEvsid, path, params)).arrayBuffer());
  }

  /**
   * Sends a `GET` to an endpoint on the account's EVS satellite host and
   * returns the raw binary body — the counterpart to {@link get} for `/evs/*`
   * endpoints that return image bytes rather than JSON/text (e.g.
   * `evs/getThumbnail`, see `docs/api-map.md`), so callers don't have their
   * binary response mangled by {@link parseResponseBody}'s text/JSON parsing.
   * Same `EVSID` bootstrap/caching/retry behavior as {@link requestEvs}.
   *
   * @param path the endpoint path, e.g. `/evs/getThumbnail`.
   * @param query optional query-string parameters to append to the URL.
   * @returns the response's declared MIME type (from its `Content-Type`
   *   header) and its raw body bytes.
   * @throws {SessionExpiredError} if the configured session has already
   *   expired.
   * @throws {MissingEvsServerError} if the configured cookie has no
   *   `EVS_SERVER` value, so the EVS host can't be determined.
   * @throws {EvsBootstrapError} if the `EVSID` handshake failed and no cached
   *   `EVSID` was usable.
   * @example
   * ```ts
   * // Mirrors the confirmed evs/getThumbnail call in docs/api-map.md
   * const thumbnail = await client.getEvs("/evs/getThumbnail", {
   *   thumbnail_type: "T",
   *   p: "/C/AMD/Support/Config",
   *   t: "1390632622",
   *   device_id: "D01637267159000960219",
   * });
   * // => { mimeType: "image/bmp", data: Buffer<...> }
   * ```
   */
  async getEvs(path: string, query?: Record<string, string>): Promise<{ mimeType: string; data: Buffer }> {
    this.assertSessionValid();
    const evsHost = this.requireEvsServerHost();

    const fetchOnce = async (evsid: string): Promise<{ mimeType: string; data: Buffer }> => {
      const url = new URL(`https://${evsHost}${path}`);
      for (const [key, value] of Object.entries(query ?? {})) {
        url.searchParams.set(key, value);
      }

      const response = await fetch(url, {
        method: "GET",
        headers: buildEvsHeaders(evsid, EVS_REFERER),
      });

      const mimeType = response.headers.get("content-type") ?? "application/octet-stream";
      const data = Buffer.from(await response.arrayBuffer());
      return { mimeType, data };
    };

    const evsid = await this.getEvsid(evsHost);
    const result = await fetchOnce(evsid);
    if (!looksLikeInvalidEvsidResponse(result.data)) {
      return result;
    }

    this.invalidateEvsid(evsHost);
    const retryEvsid = await this.getEvsid(evsHost);
    return fetchOnce(retryEvsid);
  }
}
