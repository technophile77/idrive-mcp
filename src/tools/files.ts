import path from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  DestinationWriteError,
  EvsBootstrapError,
  EvsDownloadHttpError,
  EvsDownloadTimeoutError,
  IdriveClient,
  MissingEvsServerError,
  SessionExpiredError,
} from "../client/idriveClient.js";
import type {
  BrowseFolderEntry,
  BrowseFolderResponse,
  CreateFolderResponse,
  FileEntry,
  FilePropertiesResponse,
  NoFileVersionsResponse,
  PathOperationResponse,
  RestoreDataResponse,
} from "../types/file.js";

const GET_RESTORE_DATA_PATH = "/idriveent/remote/getRestoreData";
const BROWSE_FOLDER_PATH = "/evs/browseFolder";
const GET_THUMBNAIL_PATH = "/evs/getThumbnail";
const DOWNLOAD_FILE_PATH = "/evs/downloadFile";
const GET_PROPERTIES_PATH = "/evs/getProperties";
const GET_VERSIONS_PATH = "/evs/getVersions";
const CREATE_FOLDER_PATH = "/evs/createFolder";
const DELETE_FILE_PATH = "/evs/v1/deleteFile";
const PUT_BACK_FROM_TRASH_PATH = "/evs/putBackFromTrash";

/** Shared `.describe()` text for the EVS-format `path` field, reused by both `browse_folder` and `get_thumbnail` since they take the same path format. */
const EVS_PATH_DESCRIPTION =
  'The folder or file path, in the EVS format: single leading slash plus drive letter, e.g. "/C" for a ' +
  'drive root or "/C/Users/me/Documents" for a deeper path. This endpoint has never been observed handling ' +
  'a bare root path ("/") — use the sibling `list_files` tool first to discover the available drive ' +
  "letters/roots for this device, then pass one of those (prefixed with a leading slash) here.";

/** Literal `toDate` value iDrive's own console sends on every observed `getRestoreData` call — its real meaning (likely a point-in-time restore filter) is unconfirmed, so it's reproduced verbatim rather than guessed at. */
const UNCONFIRMED_TO_DATE_LITERAL = "NaN/NaN/NaN NaN:NaN:NaN";

const listFilesInputShape = {
  deviceId: z
    .string()
    .min(1)
    .describe(
      "The iDrive device ID to browse, e.g. as returned by the sibling `list_devices` tool's `device_id` field.",
    ),
  path: z
    .string()
    .default("/")
    .describe('The folder path to list within the device\'s backed-up file tree. Root is "/".'),
  osType: z
    .string()
    .default("win")
    .describe(
      'The backed-up client\'s OS type, sent on the wire as iDrive\'s (misleadingly named) "macType" field. ' +
        'Observed value is "win" even for a Windows device in the only captured example, so this is not ' +
        "literally a Mac/non-Mac flag despite the field name — leave it at the default unless you know otherwise.",
    ),
};

const browseFolderInputShape = {
  deviceId: z
    .string()
    .min(1)
    .describe(
      "The iDrive device ID to browse, e.g. as returned by the sibling `list_devices` tool's `device_id` field.",
    ),
  path: z.string().min(1).describe(EVS_PATH_DESCRIPTION),
};

const getThumbnailInputShape = {
  deviceId: z
    .string()
    .min(1)
    .describe(
      "The iDrive device ID the file was backed up from, e.g. as returned by the sibling `list_devices` tool's `device_id` field.",
    ),
  path: z.string().min(1).describe(EVS_PATH_DESCRIPTION),
  timestamp: z
    .union([z.string(), z.number()])
    .describe(
      "The file's `lmd_web` timestamp, as returned by a prior `list_files` or `browse_folder` call's entry for " +
        "this file. There is no default — a thumbnail request needs the exact version's timestamp to identify " +
        "which cached rendering to return.",
    ),
};

/** Shared input shape for the EVS single-file tools (`download_file`, `get_file_properties`, `get_file_versions`), which all take just a `deviceId` and a file `path`. */
const evsFilePathInputShape = {
  deviceId: z
    .string()
    .min(1)
    .describe(
      "The iDrive device ID the file was backed up from, e.g. as returned by the sibling `list_devices` tool's `device_id` field.",
    ),
  path: z.string().min(1).describe(EVS_PATH_DESCRIPTION),
};

/**
 * Input shape for `download_file`, extending {@link evsFilePathInputShape}
 * with the destination it streams to. `destinationPath` is required (not
 * defaulted) — see `download_file`'s own DocBlock for why there's no
 * server-side default download directory.
 */
const downloadFileInputShape = {
  ...evsFilePathInputShape,
  destinationPath: z
    .string()
    .min(1)
    .refine(path.isAbsolute, {
      message: "destinationPath must be an absolute local file path (e.g. \"C:\\Users\\me\\Downloads\\file.txt\" or \"/home/me/file.txt\"), not a relative one.",
    })
    .describe(
      "The absolute local file path to stream the downloaded content to (its parent directory is created if " +
        "missing). Always required — this tool never chooses a download location on its own.",
    ),
};

const createFolderInputShape = {
  deviceId: z
    .string()
    .min(1)
    .describe(
      "The iDrive device ID to create the folder under, e.g. as returned by the sibling `list_devices` tool's `device_id` field.",
    ),
  parentPath: z
    .string()
    .min(1)
    .describe(
      'The EVS-format path of the existing parent folder the new folder is created inside, e.g. "/C" or ' +
        '"/C/Users/me/Documents" — the same format as `browse_folder`\'s `path`. Use `browse_folder` or ' +
        "`list_files` first to confirm this parent folder exists.",
    ),
  folderName: z
    .string()
    .min(1)
    .describe('Just the new folder\'s name (e.g. "New Folder") — not a path. It is created directly inside `parentPath`.'),
};

/** Shared `.describe()` text for the `paths` field on the batch EVS path tools (`delete_file`, `restore_from_trash`), which both accept one or more EVS-format paths sent as repeated `p` form fields in a single request. */
const EVS_BATCH_PATHS_DESCRIPTION =
  'One or more file/folder paths, in the EVS format ("/C/Users/...", same as `browse_folder`\'s `path`). ' +
  "Sent as repeated `p` fields in a single request — the response reports a result per path, so a partial " +
  "failure across multiple paths is visible rather than silent.";

const deleteFileInputShape = {
  deviceId: z
    .string()
    .min(1)
    .describe("The iDrive device ID the path(s) were backed up from, e.g. as returned by the sibling `list_devices` tool's `device_id` field."),
  paths: z.array(z.string().min(1)).min(1).describe(EVS_BATCH_PATHS_DESCRIPTION),
  permanent: z
    .boolean()
    .default(false)
    .describe(
      "When false (default), moves the path(s) to trash (sent on the wire as `trash=yes`) — this is the " +
        'ONLY behavior of this field that has been confirmed live against a real account (see ' +
        'docs/api-map.md\'s "Live mutation testing" section): the item disappears from `browse_folder` ' +
        "listings and can be recovered with the sibling `restore_from_trash` tool. When true, sends " +
        "`trash=no`, which is presumed — from the field's name and the `trash=yes` pattern, NOT " +
        "independently confirmed — to mean a permanent, non-recoverable delete. Treat `permanent: true` as " +
        "unverified until you've tested it yourself against a throwaway path; do not rely on it for " +
        "anything important without doing so first.",
    ),
};

const restoreFromTrashInputShape = {
  deviceId: z
    .string()
    .min(1)
    .describe("The iDrive device ID the path(s) were backed up from, e.g. as returned by the sibling `list_devices` tool's `device_id` field."),
  paths: z.array(z.string().min(1)).min(1).describe(EVS_BATCH_PATHS_DESCRIPTION),
};

/**
 * Builds the tool-error `CallToolResult` returned when the configured iDrive
 * session cookie has already expired, so `list_files` fails with an
 * actionable message instead of an uncaught {@link SessionExpiredError}.
 *
 * @returns an MCP tool result with `isError: true` and a human-readable
 *   instruction to refresh `IDRIVE_COOKIE`.
 */
function buildSessionExpiredResult(): CallToolResult {
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: "Your iDrive session has expired — refresh IDRIVE_COOKIE with a new Cookie header value from a logged-in idrive.com browser session.",
      },
    ],
  };
}

/**
 * Builds the tool-error `CallToolResult` returned when the authenticated
 * account's email can't be derived from the configured session cookie — the
 * `getRestoreData` call requires it as the `selUser` field, so the request
 * would be malformed without it.
 *
 * @returns an MCP tool result with `isError: true` explaining the missing
 *   account email and how to fix it.
 */
function buildMissingAccountEmailResult(): CallToolResult {
  return {
    isError: true,
    content: [
      {
        type: "text",
        text:
          "Could not determine the iDrive account email from the configured session " +
          "(missing or malformed SES_TOKEN cookie). Refresh IDRIVE_COOKIE with a new " +
          "Cookie header value from a logged-in idrive.com browser session.",
      },
    ],
  };
}

/**
 * Builds the tool-error `CallToolResult` returned when iDrive's own
 * `getRestoreData` response reports a non-`"SUCCESS"` `message` (e.g. an
 * invalid `path` or `deviceId`), so the tool surfaces iDrive's own error text
 * rather than a generic failure.
 *
 * @param idriveMessage the `message` field from the parsed API response.
 * @returns an MCP tool result with `isError: true` quoting `idriveMessage`.
 */
function buildIdriveErrorResult(idriveMessage: string): CallToolResult {
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: `iDrive returned an error for this listing request: ${idriveMessage}`,
      },
    ],
  };
}

/**
 * Builds the tool-error `CallToolResult` returned when iDrive's own response
 * to a mutating call (`create_folder`, `delete_file`, `restore_from_trash`)
 * reports a non-`"SUCCESS"` `message`, so the tool surfaces iDrive's own
 * error text instead of a generic failure — the mutating-call counterpart to
 * {@link buildIdriveErrorResult}, worded for a request that changes data
 * rather than one that only reads it.
 *
 * @param idriveMessage iDrive's own error text (its `desc` field when
 *   present, else its `message` field).
 * @returns an MCP tool result with `isError: true` quoting `idriveMessage`.
 */
function buildIdriveMutationErrorResult(idriveMessage: string): CallToolResult {
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: `iDrive returned an error for this request: ${idriveMessage}`,
      },
    ],
  };
}

/**
 * Narrows an unknown `getRestoreData` response body into a
 * {@link RestoreDataResponse}, so callers don't have to trust the shape of a
 * parsed-JSON `unknown` value returned by {@link IdriveClient.request}.
 *
 * @param body the parsed JSON response body from `getRestoreData`.
 * @returns the body cast to `RestoreDataResponse` if it has the expected
 *   `message`/`path`/`contents` fields, or `null` if the shape is
 *   unrecognizable (e.g. the API returned raw text instead of JSON).
 */
function parseRestoreDataResponse(body: unknown): RestoreDataResponse | null {
  if (
    typeof body !== "object" ||
    body === null ||
    typeof (body as { message?: unknown }).message !== "string" ||
    typeof (body as { path?: unknown }).path !== "string" ||
    !Array.isArray((body as { contents?: unknown }).contents)
  ) {
    return null;
  }

  return body as RestoreDataResponse;
}

/**
 * Narrows an unknown `evs/browseFolder` response body into a
 * {@link BrowseFolderResponse}, mirroring {@link parseRestoreDataResponse}
 * for the EVS-hosted listing endpoint's slightly richer entry shape.
 *
 * @param body the parsed JSON response body from `evs/browseFolder`.
 * @returns the body cast to `BrowseFolderResponse` if it has the expected
 *   `message`/`path`/`contents` fields, or `null` if the shape is
 *   unrecognizable (e.g. the API returned raw text instead of JSON).
 */
function parseBrowseFolderResponse(body: unknown): BrowseFolderResponse | null {
  if (
    typeof body !== "object" ||
    body === null ||
    typeof (body as { message?: unknown }).message !== "string" ||
    typeof (body as { path?: unknown }).path !== "string" ||
    !Array.isArray((body as { contents?: unknown }).contents)
  ) {
    return null;
  }

  return body as BrowseFolderResponse;
}

/**
 * Builds the tool-error `CallToolResult` returned when the configured
 * session cookie has no `EVS_SERVER` value, so an `/evs/*` call can't be
 * addressed — distinct from {@link buildSessionExpiredResult} because the fix
 * is different: the cookie itself isn't stale, it's just missing a field, so
 * refreshing `IDRIVE_COOKIE` from an incomplete copy wouldn't help.
 *
 * @returns an MCP tool result with `isError: true` explaining the missing
 *   `EVS_SERVER` cookie value and how to fix it.
 */
function buildMissingEvsServerResult(): CallToolResult {
  return {
    isError: true,
    content: [
      {
        type: "text",
        text:
          "This session's cookie doesn't contain an EVS_SERVER value, which is required to reach " +
          "the /evs/* endpoints this tool uses. Try re-copying the full Cookie header (all fields, not just " +
          "SES_TOKEN) from a logged-in idrive.com browser session, and set it as IDRIVE_COOKIE.",
      },
    ],
  };
}

/**
 * Builds the tool-error `CallToolResult` returned when the `EVSID` bootstrap
 * handshake needed to reach `/evs/*` endpoints fails (see
 * `docs/api-map.md`'s "EVSID: how the EVS session is actually established"
 * section and {@link EvsBootstrapError}) — distinct from
 * {@link buildMissingEvsServerResult}: that one means the EVS host couldn't
 * even be identified, this one means the host was known but minting a
 * session against it failed.
 *
 * @param error the caught bootstrap error; its own message already explains
 *   which handshake step failed.
 * @returns an MCP tool result with `isError: true` quoting `error.message`.
 */
function buildEvsBootstrapErrorResult(error: EvsBootstrapError): CallToolResult {
  return {
    isError: true,
    content: [{ type: "text", text: error.message }],
  };
}

/**
 * Narrows an unknown `evs/getProperties` response body into a
 * {@link FilePropertiesResponse}, mirroring {@link parseBrowseFolderResponse}'s
 * defensive-parsing pattern for this endpoint's flatter shape.
 *
 * @param body the parsed JSON response body from `evs/getProperties`.
 * @returns the body cast to `FilePropertiesResponse` if it has the expected
 *   `message`/`path` fields, or `null` if the shape is unrecognizable.
 */
function parseFilePropertiesResponse(body: unknown): FilePropertiesResponse | null {
  if (
    typeof body !== "object" ||
    body === null ||
    typeof (body as { message?: unknown }).message !== "string" ||
    typeof (body as { path?: unknown }).path !== "string"
  ) {
    return null;
  }

  return body as FilePropertiesResponse;
}

/**
 * Narrows an unknown `evs/createFolder` response body into a
 * {@link CreateFolderResponse}, mirroring {@link parseFilePropertiesResponse}'s
 * defensive-parsing pattern for this endpoint's minimal shape.
 *
 * @param body the parsed JSON response body from `evs/createFolder`.
 * @returns the body cast to `CreateFolderResponse` if it has the expected
 *   `message` field, or `null` if the shape is unrecognizable.
 */
function parseCreateFolderResponse(body: unknown): CreateFolderResponse | null {
  if (typeof body !== "object" || body === null || typeof (body as { message?: unknown }).message !== "string") {
    return null;
  }

  return body as CreateFolderResponse;
}

/**
 * Narrows an unknown `evs/v1/deleteFile` or `evs/putBackFromTrash` response
 * body into a {@link PathOperationResponse}, mirroring
 * {@link parseBrowseFolderResponse}'s defensive-parsing pattern for these
 * batch endpoints' per-path result array.
 *
 * @param body the parsed JSON response body from either endpoint.
 * @returns the body cast to `PathOperationResponse` if it has the expected
 *   `message`/`contents` fields, or `null` if the shape is unrecognizable.
 */
function parsePathOperationResponse(body: unknown): PathOperationResponse | null {
  if (
    typeof body !== "object" ||
    body === null ||
    typeof (body as { message?: unknown }).message !== "string" ||
    !Array.isArray((body as { contents?: unknown }).contents)
  ) {
    return null;
  }

  return body as PathOperationResponse;
}

/**
 * Builds a `URLSearchParams` form body for the batch EVS path endpoints
 * (`evs/v1/deleteFile`, `evs/putBackFromTrash`) that accept multiple `p`
 * fields — one per path — in a single request (see `docs/api-map.md`'s
 * "Live mutation testing" section). Kept as a standalone pure function, and
 * built directly on `URLSearchParams` rather than `IdriveClient`'s usual
 * `Record<string, string>` form-field shape, since a plain object can't
 * represent a repeated key — see {@link IdriveClient.requestEvsWithParams}.
 *
 * @param paths the file/folder paths to include, one per repeated `p` field.
 * @param extraFields the endpoint's other form fields (e.g. `trash`, `json`,
 *   `device_id`), each sent once.
 * @returns a `URLSearchParams` body with `extraFields` set once each and `p`
 *   repeated once per entry in `paths`.
 * @example
 * ```ts
 * buildRepeatedPathParams(["/C/a", "/C/b"], { json: "yes", device_id: "D01" }).toString();
 * // => "json=yes&device_id=D01&p=%2FC%2Fa&p=%2FC%2Fb"
 * ```
 */
export function buildRepeatedPathParams(paths: string[], extraFields: Record<string, string>): URLSearchParams {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(extraFields)) {
    params.append(key, value);
  }
  for (const path of paths) {
    params.append("p", path);
  }
  return params;
}

/**
 * Checks whether a parsed `evs/getVersions` response body is the confirmed
 * "no version history" shape (see {@link NoFileVersionsResponse}), so
 * `get_file_versions` can treat it as a normal, non-error result rather than
 * a tool failure — a file having no prior backed-up versions is a common,
 * legitimate outcome, not something wrong with the request.
 *
 * @param body the parsed JSON response body from `evs/getVersions`.
 * @returns `true` only when `body` matches the exact confirmed shape.
 */
function isNoFileVersionsResponse(body: unknown): body is NoFileVersionsResponse {
  return (
    typeof body === "object" &&
    body !== null &&
    (body as { message?: unknown }).message === "ERROR" &&
    (body as { desc?: unknown }).desc === "NO FILE VERSIONS FOUND"
  );
}

/**
 * Builds the tool-error `CallToolResult` returned when
 * `download_file`/`IdriveClient.downloadEvsToFile` failed with an
 * {@link EvsDownloadHttpError} — either attempt's response wasn't a 2xx
 * status, or the response still looked like the stale-EVSID error shape or
 * an HTML document after a retry (the latter is a known iDrive behavior when
 * the requested path doesn't resolve to a real file/folder) — so the tool
 * surfaces that already-clear message instead of an uncaught exception.
 *
 * @param error the caught download HTTP error; its own message already
 *   explains what went wrong.
 * @returns an MCP tool result with `isError: true` quoting `error.message`.
 */
function buildEvsDownloadHttpErrorResult(error: EvsDownloadHttpError): CallToolResult {
  return {
    isError: true,
    content: [{ type: "text", text: error.message }],
  };
}

/**
 * Builds the tool-error `CallToolResult` returned when a `download_file`
 * attempt was aborted for taking too long (see {@link EvsDownloadTimeoutError}),
 * so a genuinely stalled connection surfaces a clear message instead of an
 * uncaught exception.
 *
 * @param error the caught download timeout error; its own message already
 *   explains the timeout.
 * @returns an MCP tool result with `isError: true` quoting `error.message`.
 */
function buildEvsDownloadTimeoutErrorResult(error: EvsDownloadTimeoutError): CallToolResult {
  return {
    isError: true,
    content: [{ type: "text", text: error.message }],
  };
}

/**
 * Builds the tool-error `CallToolResult` returned when `download_file`
 * couldn't write the downloaded content to the caller-supplied
 * `destinationPath` locally (see {@link DestinationWriteError}), so a bad
 * path/permissions/disk-full problem surfaces a clear message instead of an
 * uncaught exception.
 *
 * @param error the caught local write error; its own message already names
 *   the destination path and what went wrong.
 * @returns an MCP tool result with `isError: true` quoting `error.message`.
 */
function buildDestinationWriteErrorResult(error: DestinationWriteError): CallToolResult {
  return {
    isError: true,
    content: [{ type: "text", text: error.message }],
  };
}

/**
 * Registers the file-browsing tools: `list_files` (browses a device's
 * backed-up file tree via iDrive's `getRestoreData` endpoint), and the
 * EVS-hosted `browse_folder`, `get_thumbnail`, `download_file`,
 * `get_file_properties`, and `get_file_versions` (see `docs/api-map.md`'s
 * "Second app surface" and "Live browser session findings" sections), plus
 * the mutating EVS-hosted `create_folder`, `delete_file`, and
 * `restore_from_trash` tools (see `docs/api-map.md`'s "Live mutation
 * testing" section) — these are the only tools in this codebase that change
 * real backed-up data, and their descriptions/annotations say so plainly.
 * Exists to keep tool registration grouped by resource area, mirroring the
 * pattern used by sibling files under `src/tools/`.
 *
 * @param server the MCP server instance to register the tools on.
 * @param client the shared iDrive HTTP client used to make the API calls.
 * @example
 * ```ts
 * const server = new McpServer({ name: "idrive-mcp-server", version: "0.1.0" });
 * registerFileTools(server, new IdriveClient(loadConfig().cookie));
 * ```
 */
export function registerFileTools(server: McpServer, client: IdriveClient): void {
  server.registerTool(
    "list_files",
    {
      title: "List Files",
      description:
        "Lists the files and folders backed up for a given device at a given path, browsing the device's " +
        "backed-up file tree as shown in iDrive's restore console. Use the sibling `list_devices` tool to " +
        "obtain a `deviceId`. Transparently retries with the alternate Unicode normalization (precomposed " +
        "NFC vs. decomposed NFD) if `path` contains accented characters and the first attempt fails to " +
        "resolve — some devices (confirmed: Mac/APFS-sourced ones) index paths in decomposed form, which " +
        "differs from how a typed or LLM-generated path is normally encoded.",
      inputSchema: listFilesInputShape,
      annotations: {
        title: "List Files",
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async ({ deviceId, path, osType }): Promise<CallToolResult> => {
      const selUser = client.getAccountEmail();
      if (selUser === null) {
        return buildMissingAccountEmailResult();
      }

      try {
        const response = await client.request(
          GET_RESTORE_DATA_PATH,
          {
            id: path,
            macType: osType,
            selUser,
            from: "",
            toDate: UNCONFIRMED_TO_DATE_LITERAL,
            device_id: deviceId,
          },
          { pathField: "id" },
        );

        const parsed = parseRestoreDataResponse(response);
        if (parsed === null) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: "iDrive returned an unexpected response shape for this listing request (not valid JSON with message/path/contents fields).",
              },
            ],
          };
        }

        if (parsed.message !== "SUCCESS") {
          return buildIdriveErrorResult(parsed.message);
        }

        const contents: FileEntry[] = parsed.contents;
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ path: parsed.path, contents }),
            },
          ],
        };
      } catch (error) {
        if (error instanceof SessionExpiredError) {
          return buildSessionExpiredResult();
        }
        throw error;
      }
    },
  );

  server.registerTool(
    "browse_folder",
    {
      title: "Browse Folder (EVS)",
      description:
        "Lists the files and folders backed up for a given device at a given path, via the richer EVS-hosted " +
        '`evs/browseFolder` endpoint (adds trash/checksum/live-image fields beyond `list_files`). The `path` ' +
        'must be in the EVS format ("/C", "/C/Users/...") — use the sibling `list_files` tool first to ' +
        "discover the available drive letters/roots for this device, since a bare root path has never been " +
        "observed working here.",
      inputSchema: browseFolderInputShape,
      annotations: {
        title: "Browse Folder (EVS)",
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async ({ deviceId, path }): Promise<CallToolResult> => {
      try {
        const response = await client.requestEvs(BROWSE_FOLDER_PATH, {
          p: path,
          json: "yes",
          devices: "yes",
          device_id: deviceId,
        });

        const parsed = parseBrowseFolderResponse(response);
        if (parsed === null) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: "iDrive returned an unexpected response shape for this listing request (not valid JSON with message/path/contents fields).",
              },
            ],
          };
        }

        if (parsed.message !== "SUCCESS") {
          return buildIdriveErrorResult(parsed.message);
        }

        const contents: BrowseFolderEntry[] = parsed.contents;
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ path: parsed.path, contents }),
            },
          ],
        };
      } catch (error) {
        if (error instanceof SessionExpiredError) {
          return buildSessionExpiredResult();
        }
        if (error instanceof MissingEvsServerError) {
          return buildMissingEvsServerResult();
        }
        if (error instanceof EvsBootstrapError) {
          return buildEvsBootstrapErrorResult(error);
        }
        throw error;
      }
    },
  );

  server.registerTool(
    "get_thumbnail",
    {
      title: "Get Thumbnail (EVS)",
      description:
        "Fetches a thumbnail preview image for a backed-up file, via the EVS-hosted `evs/getThumbnail` " +
        'endpoint. The `path` must be in the EVS format ("/C/Users/..."), and `timestamp` must be the file\'s ' +
        "`lmd_web` value from a prior `list_files` or `browse_folder` call's entry for it — there's no way to " +
        "guess a correct timestamp without one of those calls first.",
      inputSchema: getThumbnailInputShape,
      annotations: {
        title: "Get Thumbnail (EVS)",
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async ({ deviceId, path, timestamp }): Promise<CallToolResult> => {
      try {
        const thumbnail = await client.getEvs(GET_THUMBNAIL_PATH, {
          thumbnail_type: "T",
          p: path,
          t: String(timestamp),
          device_id: deviceId,
        });

        return {
          content: [
            {
              type: "image",
              data: thumbnail.data.toString("base64"),
              mimeType: thumbnail.mimeType,
            },
          ],
        };
      } catch (error) {
        if (error instanceof SessionExpiredError) {
          return buildSessionExpiredResult();
        }
        if (error instanceof MissingEvsServerError) {
          return buildMissingEvsServerResult();
        }
        if (error instanceof EvsBootstrapError) {
          return buildEvsBootstrapErrorResult(error);
        }
        throw error;
      }
    },
  );

  server.registerTool(
    "download_file",
    {
      title: "Download File (EVS)",
      description:
        "Downloads a backed-up file's actual content, via the EVS-hosted `evs/downloadFile` endpoint, streaming " +
        "it straight to a local file at the required `destinationPath` rather than returning it inline — large " +
        "files inlined into a single tool response can exceed the MCP stdio transport's message size limit, so " +
        "this tool always writes to disk and reports back `{ path, bytesWritten }` instead. Use `browse_folder` " +
        "or `list_files` first to discover the `path` of the file you want. Note: iDrive's `Content-Type` header " +
        "on this endpoint is NOT trustworthy for identifying the real file type (it's always " +
        "`text/plain;charset=UTF-8` regardless of actual content) — the downloaded data is an opaque byte " +
        "stream; use the file's own name/extension (from a prior listing) to infer its type instead. " +
        "Transparently retries with the alternate Unicode normalization (precomposed NFC vs. decomposed NFD) " +
        "if `path` contains accented characters and the first attempt fails to resolve; when that retry is " +
        "what actually worked, the result includes a `sourcePathNormalizedTo` field showing the form that " +
        "succeeded.",
      inputSchema: downloadFileInputShape,
      annotations: {
        title: "Download File (EVS)",
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async ({ deviceId, path, destinationPath }): Promise<CallToolResult> => {
      try {
        const { bytesWritten, pathUsed } = await client.downloadEvsToFile(
          DOWNLOAD_FILE_PATH,
          { p: path, json: "yes", device_id: deviceId },
          destinationPath,
        );

        const result: { path: string; bytesWritten: number; sourcePathNormalizedTo?: string } = {
          path: destinationPath,
          bytesWritten,
        };
        if (pathUsed !== path) {
          result.sourcePathNormalizedTo = pathUsed;
        }

        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
        };
      } catch (error) {
        if (error instanceof SessionExpiredError) {
          return buildSessionExpiredResult();
        }
        if (error instanceof MissingEvsServerError) {
          return buildMissingEvsServerResult();
        }
        if (error instanceof EvsBootstrapError) {
          return buildEvsBootstrapErrorResult(error);
        }
        if (error instanceof EvsDownloadHttpError) {
          return buildEvsDownloadHttpErrorResult(error);
        }
        if (error instanceof EvsDownloadTimeoutError) {
          return buildEvsDownloadTimeoutErrorResult(error);
        }
        if (error instanceof DestinationWriteError) {
          return buildDestinationWriteErrorResult(error);
        }
        throw error;
      }
    },
  );

  server.registerTool(
    "get_file_properties",
    {
      title: "Get File Properties (EVS)",
      description:
        "Fetches metadata (size, last-modified date) for a single backed-up file or folder, via the EVS-hosted " +
        "`evs/getProperties` endpoint. Matches the \"Folder size / File count / Modified date\" info dialog in " +
        "iDrive's own UI. Use `browse_folder` or `list_files` first to discover the `path` to query.",
      inputSchema: evsFilePathInputShape,
      annotations: {
        title: "Get File Properties (EVS)",
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async ({ deviceId, path }): Promise<CallToolResult> => {
      try {
        const response = await client.requestEvs(GET_PROPERTIES_PATH, {
          p: path,
          json: "yes",
          device_id: deviceId,
        });

        const parsed = parseFilePropertiesResponse(response);
        if (parsed === null) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: "iDrive returned an unexpected response shape for this properties request (not valid JSON with message/path fields).",
              },
            ],
          };
        }

        if (parsed.message !== "SUCCESS") {
          return buildIdriveErrorResult(parsed.message);
        }

        return {
          content: [{ type: "text", text: JSON.stringify(parsed) }],
        };
      } catch (error) {
        if (error instanceof SessionExpiredError) {
          return buildSessionExpiredResult();
        }
        if (error instanceof MissingEvsServerError) {
          return buildMissingEvsServerResult();
        }
        if (error instanceof EvsBootstrapError) {
          return buildEvsBootstrapErrorResult(error);
        }
        throw error;
      }
    },
  );

  server.registerTool(
    "get_file_versions",
    {
      title: "Get File Versions (EVS)",
      description:
        "Lists prior backed-up versions of a single file, via the EVS-hosted `evs/getVersions` endpoint. Only " +
        'the "no version history" response shape has been confirmed live so far (see `docs/api-map.md`) — a ' +
        "file with no prior versions is reported as a normal, successful result (not a tool error), with " +
        '`hasVersions: false`. The shape of a real version list (a file that DOES have multiple backed-up ' +
        "versions) is unconfirmed, so when iDrive reports success this tool returns iDrive's raw JSON as-is " +
        "rather than guessing at a mapped shape — treat those fields as unstable until a real example has been " +
        "observed. Use `browse_folder` or `list_files` first to discover the `path` to query.",
      inputSchema: evsFilePathInputShape,
      annotations: {
        title: "Get File Versions (EVS)",
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async ({ deviceId, path }): Promise<CallToolResult> => {
      try {
        const response = await client.requestEvs(GET_VERSIONS_PATH, {
          p: path,
          json: "yes",
          device_id: deviceId,
        });

        if (isNoFileVersionsResponse(response)) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  path: response.path,
                  hasVersions: false,
                  note: "No prior backed-up versions were found for this file.",
                }),
              },
            ],
          };
        }

        const message =
          typeof response === "object" && response !== null
            ? (response as { message?: unknown }).message
            : undefined;

        if (message === "SUCCESS") {
          // Success shape is unconfirmed (see docs/api-map.md) — pass iDrive's raw response through as-is
          // rather than guessing at a mapped shape.
          return {
            content: [{ type: "text", text: JSON.stringify(response) }],
          };
        }

        if (typeof message === "string") {
          return buildIdriveErrorResult(message);
        }

        return {
          isError: true,
          content: [
            {
              type: "text",
              text: "iDrive returned an unexpected response shape for this version-history request (not valid JSON with a message field).",
            },
          ],
        };
      } catch (error) {
        if (error instanceof SessionExpiredError) {
          return buildSessionExpiredResult();
        }
        if (error instanceof MissingEvsServerError) {
          return buildMissingEvsServerResult();
        }
        if (error instanceof EvsBootstrapError) {
          return buildEvsBootstrapErrorResult(error);
        }
        throw error;
      }
    },
  );

  server.registerTool(
    "create_folder",
    {
      title: "Create Folder (EVS) — mutating",
      description:
        "MUTATING: creates a new folder inside a device's live backup, via the EVS-hosted " +
        "`evs/createFolder` endpoint. This modifies real backed-up data — the new folder appears in " +
        "subsequent `browse_folder`/`list_files` listings (confirmed live against a real device, see " +
        '`docs/api-map.md`\'s "Live mutation testing" section). `parentPath` must be an existing folder ' +
        '(use `browse_folder`/`list_files` first to confirm it exists); `folderName` is just the new ' +
        "folder's name, not a path.",
      inputSchema: createFolderInputShape,
      annotations: {
        title: "Create Folder (EVS)",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ deviceId, parentPath, folderName }): Promise<CallToolResult> => {
      try {
        const response = await client.requestEvs(CREATE_FOLDER_PATH, {
          foldername: folderName,
          p: parentPath,
          json: "yes",
          device_id: deviceId,
        });

        const parsed = parseCreateFolderResponse(response);
        if (parsed === null) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: "iDrive returned an unexpected response shape for this create-folder request (not valid JSON with a message field).",
              },
            ],
          };
        }

        if (parsed.message !== "SUCCESS") {
          return buildIdriveMutationErrorResult(parsed.desc ?? parsed.message);
        }

        return {
          content: [{ type: "text", text: JSON.stringify(parsed) }],
        };
      } catch (error) {
        if (error instanceof SessionExpiredError) {
          return buildSessionExpiredResult();
        }
        if (error instanceof MissingEvsServerError) {
          return buildMissingEvsServerResult();
        }
        if (error instanceof EvsBootstrapError) {
          return buildEvsBootstrapErrorResult(error);
        }
        throw error;
      }
    },
  );

  server.registerTool(
    "delete_file",
    {
      title: "Delete File/Folder (EVS) — mutating, destructive",
      description:
        "MUTATING, DESTRUCTIVE: removes one or more files/folders from a device's live backup, via the " +
        "EVS-hosted `evs/v1/deleteFile` endpoint, in a single batch call across all of `paths`. By default " +
        "(`permanent: false`) this moves the path(s) to trash — confirmed live against a real device (see " +
        '`docs/api-map.md`\'s "Live mutation testing" section): the item(s) disappear from ' +
        "`browse_folder`/`list_files` listings immediately, and can be undone with the sibling " +
        "`restore_from_trash` tool. Setting `permanent: true` is presumed (NOT independently confirmed — " +
        "see the `permanent` parameter's own description) to bypass trash and delete the data with no way " +
        "to recover it. Always double-check `paths` before calling this, especially with `permanent: true`.",
      inputSchema: deleteFileInputShape,
      annotations: {
        title: "Delete File/Folder (EVS)",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ deviceId, paths, permanent }): Promise<CallToolResult> => {
      try {
        const params = buildRepeatedPathParams(paths, {
          trash: permanent ? "no" : "yes",
          json: "yes",
          device_id: deviceId,
        });
        const response = await client.requestEvsWithParams(DELETE_FILE_PATH, params);

        const parsed = parsePathOperationResponse(response);
        if (parsed === null) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: "iDrive returned an unexpected response shape for this delete request (not valid JSON with message/contents fields).",
              },
            ],
          };
        }

        if (parsed.message !== "SUCCESS") {
          return buildIdriveMutationErrorResult(parsed.message);
        }

        return {
          content: [{ type: "text", text: JSON.stringify({ contents: parsed.contents }) }],
        };
      } catch (error) {
        if (error instanceof SessionExpiredError) {
          return buildSessionExpiredResult();
        }
        if (error instanceof MissingEvsServerError) {
          return buildMissingEvsServerResult();
        }
        if (error instanceof EvsBootstrapError) {
          return buildEvsBootstrapErrorResult(error);
        }
        throw error;
      }
    },
  );

  server.registerTool(
    "restore_from_trash",
    {
      title: "Restore From Trash (EVS) — mutating",
      description:
        "MUTATING: restores one or more previously trashed files/folders back to their original location, " +
        "via the EVS-hosted `evs/putBackFromTrash` endpoint, in a single batch call across all of `paths`. " +
        'Confirmed live against a real device (see `docs/api-map.md`\'s "Live mutation testing" section): ' +
        "the item(s) reappear in subsequent `browse_folder`/`list_files` listings. Only undoes a prior " +
        "trash-move (e.g. from the sibling `delete_file` tool with `permanent: false`) — there is no " +
        "confirmed way to enumerate what's currently in trash, so `paths` must already be known.",
      inputSchema: restoreFromTrashInputShape,
      annotations: {
        title: "Restore From Trash (EVS)",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ deviceId, paths }): Promise<CallToolResult> => {
      try {
        const params = buildRepeatedPathParams(paths, { json: "yes", device_id: deviceId });
        const response = await client.requestEvsWithParams(PUT_BACK_FROM_TRASH_PATH, params);

        const parsed = parsePathOperationResponse(response);
        if (parsed === null) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: "iDrive returned an unexpected response shape for this restore-from-trash request (not valid JSON with message/contents fields).",
              },
            ],
          };
        }

        if (parsed.message !== "SUCCESS") {
          return buildIdriveMutationErrorResult(parsed.message);
        }

        return {
          content: [{ type: "text", text: JSON.stringify({ contents: parsed.contents }) }],
        };
      } catch (error) {
        if (error instanceof SessionExpiredError) {
          return buildSessionExpiredResult();
        }
        if (error instanceof MissingEvsServerError) {
          return buildMissingEvsServerResult();
        }
        if (error instanceof EvsBootstrapError) {
          return buildEvsBootstrapErrorResult(error);
        }
        throw error;
      }
    },
  );
}
