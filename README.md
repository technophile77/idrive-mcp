# idrive-mcp-server

An MCP (Model Context Protocol) server that exposes iDrive's web backup/restore
console as tools for an MCP-compatible AI assistant (e.g. Claude Desktop or
Claude Code). It talks to iDrive's undocumented internal web API — the same
endpoints the `idrive.com` console itself calls — using a session cookie
copied from a logged-in browser, since iDrive doesn't offer a public API or
OAuth flow for this console. See `docs/api-map.md` for the reverse-engineered
endpoint reference this server is built from.

## Getting `IDRIVE_COOKIE`

1. Log in to [idrive.com](https://www.idrive.com) in your browser.
2. Open DevTools -> Network tab.
3. Click any XHR request made to `www.idrive.com`.
4. Copy the full value of that request's `Cookie` header.
5. Put it in a `.env` file (copy `.env.example`) as `IDRIVE_COOKIE=<value>`.

This cookie contains a session token (`SES_TOKEN`, a JWT) that expires after
roughly 24 hours — when it does, tool calls will fail with a clear "refresh
your session" error and you'll need to repeat the steps above.

## Configuring in Claude Code / Claude Desktop

Add an entry to your MCP config (`.mcp.json` for Claude Code, or
`claude_desktop_config.json` for Claude Desktop):

```json
{
  "mcpServers": {
    "idrive": {
      "command": "npx",
      "args": ["tsx", "src/index.ts"],
      "cwd": "/absolute/path/to/idrive-mcp-server",
      "env": {
        "IDRIVE_COOKIE": "<your cookie value>"
      }
    }
  }
}
```

Or, after running `npm run build`, point `command`/`args` at the built output
instead:

```json
{
  "mcpServers": {
    "idrive": {
      "command": "node",
      "args": ["dist/index.js"],
      "cwd": "/absolute/path/to/idrive-mcp-server",
      "env": {
        "IDRIVE_COOKIE": "<your cookie value>"
      }
    }
  }
}
```

## Available tools

- **`list_devices`** — no input. Lists every device backed up under the
  authenticated iDrive account (device ID, OS, nickname, IP address, and
  backup bucket location), via the EVS-hosted `evs/listDevices` endpoint.
  Requires no configuration beyond `IDRIVE_COOKIE`.
- **`list_files`** — `deviceId` (required), `path` (default `"/"`), `osType`
  (default `"win"`). Browses a device's backed-up file tree via iDrive's
  `getRestoreData` endpoint.
- **`browse_folder`** — `deviceId` (required), `path` (required, EVS format:
  `"/C"`, `"/C/Users/..."`). Browses a device's backed-up folder via the
  richer EVS-hosted `evs/browseFolder` endpoint (adds trash/checksum/live-image
  fields beyond `list_files`). Use `list_files` first to discover a device's
  available drive letters/roots, since `evs/browseFolder` has never been
  observed handling a bare root path.
- **`get_thumbnail`** — `deviceId` (required), `path` (required, same EVS
  format as `browse_folder`), `timestamp` (required — the file's `lmd_web`
  value from a prior `list_files`/`browse_folder` call). Fetches a thumbnail
  preview image for a backed-up file via the EVS-hosted `evs/getThumbnail`
  endpoint, returned as MCP image content.
- **`download_file`** — `deviceId` (required), `path` (required, same EVS
  format as `browse_folder`). Downloads a backed-up file's actual content via
  the EVS-hosted `evs/downloadFile` endpoint, returned as base64-encoded MCP
  resource content. iDrive's `Content-Type` on this endpoint is not
  trustworthy for identifying the real file type — infer it from the file's
  name/extension instead.
- **`get_file_properties`** — `deviceId` (required), `path` (required, same
  EVS format as `browse_folder`). Fetches size/last-modified metadata for a
  single backed-up file or folder via the EVS-hosted `evs/getProperties`
  endpoint.
- **`get_file_versions`** — `deviceId` (required), `path` (required, same EVS
  format as `browse_folder`). Lists prior backed-up versions of a file via
  the EVS-hosted `evs/getVersions` endpoint. Only the "no version history"
  response shape is confirmed so far — a file with no prior versions is
  reported as a normal result (`hasVersions: false`), not a tool error; the
  shape of a real version list is unconfirmed and returned as raw JSON.
- **`get_account_usage`** — no input. Returns the account's used/total Sync
  storage quota as raw strings (e.g. `"0.00 KB"`, `"5000.00 GB"`), scraped
  from two inline `<script>` variables on iDrive's `account.html` page —
  there is no dedicated JSON usage endpoint. Fragile by nature (an HTML
  scrape, not a stable API) and reflects the page's own "Sync" quota naming
  specifically; whether it also represents total usage across device backups
  is unconfirmed.

### Mutating tools

The tools below **change real backed-up data** on the account, unlike every
tool above (all read-only). Their descriptions and MCP `annotations` say so
explicitly (`readOnlyHint: false`, and `destructiveHint: true` for
`delete_file`).

- **`create_folder`** — `deviceId` (required), `parentPath` (required, EVS
  format, must be an existing folder), `folderName` (required — just the new
  folder's name, not a path). Creates a new folder inside a device's live
  backup via the EVS-hosted `evs/createFolder` endpoint. Confirmed live: the
  new folder appears in subsequent `browse_folder`/`list_files` listings.
- **`delete_file`** — `deviceId` (required), `paths` (required, array of one
  or more EVS-format paths — sent as repeated `p` fields in a single batch
  call), `permanent` (optional, default `false`). Removes file(s)/folder(s)
  from a device's live backup via the EVS-hosted `evs/v1/deleteFile`
  endpoint. `permanent: false` (default) moves the path(s) to trash —
  confirmed live, and recoverable with `restore_from_trash`. `permanent:
  true` sends `trash=no`, presumed (from the field's name/pattern) to mean a
  permanent, non-recoverable delete, but **this has never been
  independently confirmed live** — treat it as unverified before relying on
  it.
- **`restore_from_trash`** — `deviceId` (required), `paths` (required, array
  of one or more EVS-format paths, same repeated-`p` batching as
  `delete_file`). Restores previously trashed file(s)/folder(s) to their
  original location via the EVS-hosted `evs/putBackFromTrash` endpoint.
  Confirmed live. There is no confirmed way to enumerate what's currently in
  trash, so `paths` must already be known.

All EVS-hosted tools (`browse_folder`, `get_thumbnail`, `download_file`,
`get_file_properties`, `get_file_versions`, `list_devices`, `create_folder`,
`delete_file`, `restore_from_trash`) transparently bootstrap and cache the
`EVSID` session the EVS satellite host requires (see `docs/api-map.md`'s
"EVSID: how the EVS session is actually established" section) — no extra
configuration is needed beyond `IDRIVE_COOKIE`, but they do require the
cookie's `EVS_SERVER` value (present on cookies copied from `/idrive/home`,
not necessarily on ones copied from the `idriveent` console) to know which
EVS host to bootstrap against.

## Testing

`npm test` runs the unit tests unconditionally, plus a set of live
integration tests that are gated behind environment variables and skip
cleanly when unset:

- **`IDRIVE_COOKIE`** — required for any integration test to run at all.
- **`IDRIVE_TEST_DEVICE_ID`** — a real `device_id` (from `list_devices`) most
  integration tests need.
- **`IDRIVE_TEST_EVS_PATH`** — a real EVS-format path (e.g. `/C`) that most
  integration tests browse/read under.
- **`IDRIVE_TEST_ALLOW_MUTATIONS=1`** — a **separate, explicit opt-in**
  required, on top of the three variables above, before the
  `create_folder`/`delete_file`/`restore_from_trash` integration test in
  `src/tools/files.test.ts` will run. That test mutates a real account: it
  creates a uniquely-named throwaway folder under `IDRIVE_TEST_EVS_PATH`
  (so repeat runs never collide), exercises all three tools against it, and
  cleans up by moving it to trash before the test ends — even if an
  assertion fails partway through (`try`/`finally`). Without this variable
  set to exactly `"1"`, that test is skipped, so a developer who's only set
  up `IDRIVE_COOKIE`/`IDRIVE_TEST_DEVICE_ID`/`IDRIVE_TEST_EVS_PATH` for
  read-only testing can run `npm test` without risk of it touching real
  data.

`get_account_usage`'s integration test is read-only and only needs
`IDRIVE_COOKIE`, same as the other account tools.

## Status

Config loading, session-expiry detection, and the shared HTTP client
(`src/client/idriveClient.ts`) are in place; MCP tools are being added
incrementally under `src/tools/` (see "Available tools" above).
