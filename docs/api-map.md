# iDrive Web API Map

Reverse-engineered from a live authenticated session (HAR export covering login → dashboard load) plus static analysis of the app's own JavaScript bundles, which reference many more endpoints than were actually called during that session. This is a **living document** — sections marked `CONFIRMED` have a real observed request/response; sections marked `DISCOVERED (unconfirmed)` are endpoint names/paths found by grepping the app's JS but never observed firing, so their request/response shape is a guess until we capture a real call.

## App structure (important)

This account lands on `https://www.idrive.com/idrive/in/console`, which loads a bundle internally namespaced `idriveent` (all API paths are under `/idriveent/...`, plus a couple of legacy paths directly under `/idrive/...`). This is the same backend the original `POST /idrive/home/setDeviceList` example call talks to — `getListDevicesForSub` (below) returned the identical four devices from that example, confirming it's one account/session. `setDeviceList` itself looks like a client-side "remember last-viewed device list" call, not the source of truth — treat `getListDevicesForSub` as the real device list endpoint.

This particular UI reads as an IT-style **"Remote Management" backup console**: browse a device's backed-up file tree, queue a restore job, poll it, download the result — rather than a live synced drive. Static analysis of every JS file in the captured bundle found **no endpoints for share links, rename, move, or create-folder** under `idriveent`.

**Update**: a second HAR confirmed there's a *second* app surface — the actual `/idrive/home` consumer file browser, which talks to a per-account satellite host (`evsweb*.idrive.com`, see "Second app surface" below), not `idriveent`. Share/rename/move/create-folder most likely live there instead, under `/evs/*`, alongside `browseFolder`/`getThumbnail` — just not yet captured. User confirmed (2026-08-26) they do use these features day-to-day and will send further curls — treat this as "still pending capture," not "doesn't exist."

## Auth flow (reference only — v1 uses manual cookie, not automated login)

1. `POST /idriveent/login/validateUser` — form fields `userId` (email), `token` (a numeric code — this account has 2FA/OTP, not a plain password post; the password step wasn't captured, it happens earlier), `supportLogin`. Returns `302` with `Set-Cookie` for the session (`JSESSIONID`, `SES_TOKEN` JWT, etc. — same cookies as the original example).
2. Trusted-device / WebOTP: `POST /idriveent/trusted/sendWEBOTP`, `POST /idriveent/trusted/verifyWEBOTP` — unconfirmed shape.
3. `POST /idriveent/login/logout`, `GET/POST /idriveent/logout` — end session.

`SES_TOKEN` is a JWT (`{user_id, id, sub, iat, exp}`); `exp` is ~24h after `iat` in the example given. The MCP server should decode this locally (no signature check needed, just read `exp`) to fail fast with a clear "refresh your cookie" error instead of letting a stale-session request fail cryptically downstream.

## CSRF

`POST /idriveent/csrf/get-token` → `{"csrf": "<token>"}`, then send it back as request header `csrf_token: <token>` on the actual mutating call. Client-side code (`idCommonAjax.js`) only auto-applies this for `/idriveent/sub/user/createUser` — other mutating endpoints observed in the JS (`sendRestore`, `home/fileDeleteEvent`, `propset/configAccount`, etc.) don't reference `csrf` at all in their own files, so CSRF may not be required for them. Treat as: try without it first; if a call fails with something like a 403/session error, fetch a token and retry with the header.

## Standard request shape

Almost everything is `POST` with `Content-Type: application/x-www-form-urlencoded; charset=UTF-8`, form fields (not JSON body) — some field values are themselves JSON strings (e.g. `device_list` in the original example). Standard browser-mimicking headers are required: `X-Requested-With: XMLHttpRequest`, `Origin`/`Referer` set to `https://www.idrive.com` / the current console page, plus a real `User-Agent` and `sec-ch-ua*` triplet — the original example curl has a full reference set to copy into the client's default headers.

---

## Second app surface: EVS satellite servers (the real `/idrive/home` consumer UI)

A second, smaller HAR (`www.idrive.com2.har`, 9 idrive-related requests) captured actual folder browsing on `/idrive/home` — the same app the very first example curl (`setDeviceList`) came from, and distinct from the `idriveent` "Remote Management" console above. It confirmed this app talks to a **per-account satellite host**, not `www.idrive.com` directly: `evsweb5187.idrive.com` in this account's case, matching the `EVS_SERVER` cookie already present in the original example's `Cookie:` header. That means **the EVS host doesn't need its own lookup call — it's already in the session cookie** (`EVS_SERVER=evsweb5187.idrive.com`), the same way the account email is embedded in `SES_TOKEN`. (`/idriveent/user/evstoken/getevsinfo` from the first HAR is presumably the server-side source of this cookie value, but we never captured its response body — not needed now that the cookie itself gives us the host directly.)

Caveat: only confirmed for one device so far. If different devices/buckets live on different storage clusters, `EVS_SERVER` might not be universal across all devices on the account — unverified either way. Treat as "best evidence available," not certain.

Headers for EVS-host calls: same cookie/`X-Requested-With` as `www.idrive.com` calls, but `Referer: https://www.idrive.com/` (root, no `/idrive/home` path) for `browseFolder`/`getThumbnail` specifically — different from the idriveent console's `Referer`.

### `POST https://<evs-host>/evs/browseFolder` — browse a device's backed-up folder (richer than `getRestoreData`)
Request (form): `p` (path — format is `//<DriveLetter>` for a drive root, e.g. `//C`, or `//<DriveLetter>/sub/path` for deeper folders — note the **double leading slash**; never observed a bare `/` root call, so how to list the drive letters themselves via this endpoint is unconfirmed — `getRestoreData`'s `id: "/"` is still the only confirmed way to get top-level drives), `json=yes`, `device_id`.
Response (JSON), one entry per item — same fields as `getRestoreData` plus a few more:
```json
{"message":"SUCCESS","path":"//C/AMD/Support/.../Config","contents":[{
  "is_dir":false,"name":"PackageSubType.Dat","size":"10517","ver":"1",
  "lmd":"2014/01/24 22:50:22","lmd_web":"1390632622","split_backup":"0",
  "thumb_exists":false,"attrib_star":"0","attrib_desc":"-","in_trash":"0",
  "share":"-","capture_date":"-","save_time":"2021/11/18 14:31:01",
  "chk":"NA","live_image":"0","wlib":"0"
}, ...]}
```
`in_trash` is a real, populated field here (unlike `getRestoreData`, where `share` was always `"-"` and no `in_trash` field existed at all) — this is a stronger lead on trash-listing than anything found in `idriveent`, though still just a per-item flag, not a "list everything in trash" call.

### `GET https://<evs-host>/evs/getThumbnail?thumbnail_type=T&p=<path>&t=<lmd_web timestamp>&device_id=<id>` — thumbnail image
Returns raw image bytes (`image/bmp` in the observed example — likely varies by source file type). `t` appears to be the file's `lmd_web` timestamp (cache-busting/version, unconfirmed).

### `POST /idrive/home/trusted/checkWEBip` — checks whether the caller's IP is a trusted one for the account
Response: `{"message":"SUCCESS","desc":{"ip":"<ip>","is_trusted":true}}`. Session/trust-related, not useful as a standalone tool.

### `POST /idrive/home/updateEvent` — fire-and-forget "viewed" telemetry
Form: `path`, `resourceName`, `action` (`"viewed"` observed). Not useful as a tool (write-only analytics ping, mirrors `/idriveent/access/record` from the first HAR).

---

## CONFIRMED endpoints

### `POST /idriveent//remote/getListDevicesForSub` — list devices
Request (form): `json=yes`, `username=<account email>`
Response (`text/plain`, JSON body):
```json
{"contents":[{
  "loc":"ajc","device_id":"D01637267159000960219","os":"Microsoft Windows 7 Professional",
  "bucket_type":"D","server_root":"D01637267159000951218","nick_name":"ACRESSWELL01-D",
  "ip":"73.203.45.23","bucket_ctime":"2021/11/18 12:25:59","uniqueId":"5d964e08bf6240adb46943d486eb33a9"
}, ...]}
```
Maps to tool: `list_devices`.

### `POST /idriveent/remote/getRestoreData` — browse a device's backed-up file tree
Request (form): `id` (path, `/` for root), `macType` (`win`|`mac`|...), `selUser` (account email), `from` (unclear, empty in example), `toDate` (unclear — `NaN/NaN/NaN NaN:NaN:NaN` in example, likely a point-in-time restore filter, untested), `device_id`
Response (JSON):
```json
{"message":"SUCCESS","path":"/","contents":[{
  "split_backup":"0","is_dir":true,"name":"E","size":"-","ver":"-",
  "lmd":"2021/11/23 12:44:40","lmd_web":"1637700280","thumb_exists":false,
  "attrib_star":"0","attrib_desc":"-","share":"-","capture_date":"0","save_time":"2021/11/23 12:44:40"
}, ...]}
```
Note the `share` field is always `"-"` in observed data — worth checking if it ever becomes populated (would confirm/deny sharing exists for this console). Maps to tool: `list_files`.

### `GET /idrive/home/products/account/exists`
Response (`text/plain`, JSON body): `{"showRPCLHS":true,"showE2LHS":true,"show360LHS":true}` — feature flags for which product sections (Remote PC, E2 object storage, 360 backup) show in the left nav. Maps to tool: `get_account_features` (low priority).

### `GET /idrive/home/c2c/custom/plan/user` — cloud-to-cloud plan/pricing info
Response: `{"customPlanExists":false,"nooffertarmonthlyprice":"2.00","offerPercentage":100,"noofferyearlyprice":"20.00","plantype":"Y","plan":"20.00/Seat/Year","yearlyprice":"20.00","monthlyprice":"2.00","promocodeExists":false}` — this is pricing/upsell data, not actual connected-account data. **Does not answer** what we need for the cloud-to-cloud scope item (listing/browsing actual Google Drive/iCloud backups) — still need a real capture of that flow.

### `GET /idriveent/user/getDashboard`
Response: `[]` (empty in this session — need a capture where this returns real data to know its shape).

### `POST /idriveent/websock/websockTime` / `POST /idriveent/websock/websockToken`
Form: `admin=<email>`. Returns short opaque tokens/timestamps used to open a `wss://wsn30s.idrive.com/ws/evsnotify/<base64 email>/...` websocket for live device-status push notifications. Out of scope for v1 (polling is fine for an MCP tool), but documented in case live status becomes worth adding later.

### `POST /idriveent/access/record` — heartbeat/analytics ping
Body (JSON): `{"computerId":"<uniqueId>_Owner_<email>","online":"0"}`. Not useful as a tool.

---

## DISCOVERED (unconfirmed) — found via static JS analysis, shape unknown, need a real curl/HAR capture

| Endpoint | Likely purpose | Source file |
|---|---|---|
| `POST /idriveent/remote/sendRestore` | Queue a restore job for selected files/folders | `RemoteManageRestore.js` |
| `POST /idriveent/remote/sendRestorePath` | Set/confirm the restore destination path | `RemoteManageRestore.js` |
| `GET/POST /idriveent/remote/getProgress` | Poll a queued restore job's progress | `RemoteManageRestore.js` |
| `POST /idriveent/remote/getRestoreLocTreeView` | Tree view for picking a restore destination | `RemoteManageRestore.js` |
| `POST /idriveent/remote/getRmgRestorePath` | Related to restore path resolution | `RemoteManageRestore.js` |
| `POST /idriveent/home/fileDeleteEvent` | Delete a file/folder from a backup | `RemoteManageRestore.js` |
| `POST /idriveent/remote/getVersions` | List prior versions of a file | `RemoteListing.js` (referenced) |
| `POST /idriveent/version/versioncheck` | Version-related, purpose unclear (client version check vs file version?) | `RemoteListing.js` |
| `POST /idriveent/remote/getRemoteEvents` | Session/activity log entries | `IDSessionLogs.js` |
| `GET /idriveent/remote/downloadLogs` | Download a log file | `commonfn.js` |
| `POST /idriveent/remote/getServerAddress` | Resolve the storage server for a device | `RemoteManage.js` |
| `POST /idriveent/remote/getSubProperties` | Device/sub-account properties | referenced |
| `POST /idriveent/propset/configAccount` / `/idriveent/propset/settings` | Account/device settings read-write | `RemoteManage.js` |
| `GET /idriveent/user/account` | Account details (likely usage/quota) | `_remote_devices` page |
| `POST /idriveent/remote/checkSubAccount`, `restoreSubAccount`, `updateSArestore`, `validateSubPvtkey` | Multi-user/sub-account restore flow (private-encryption-key protected accounts — see below) | `RemoteManage.js` |
| `POST /idriveent/sub/user/createUser`, `/idriveent/sub/user/addUser` | Team/sub-user management | `idCommonAjax.js`, `idHeader.js` |

**Not found anywhere**: share/share-link, rename, move, create-folder, trash/recycle-bin. See "App structure" above — needs your confirmation before I build (or explicitly drop) those tools.

## Client-side encryption (flag for later)

The bundle ships `aes.js`, `pbkdf2.js`, `idAes.js`, and restore flow endpoints reference a "private key" (`validateSubPvtkey`). iDrive supports a "private encryption key" backup mode where content is encrypted client-side before upload — if any of your devices use that mode, restoring/downloading their files may require replicating this AES/PBKDF2 key-derivation client-side, not just calling an API. Flag if this applies to any of your 4 devices; if none use private-key encryption, this whole concern drops.

## Live browser session findings (2026-08-26/27, via Chrome DevTools MCP)

With direct browser access (Chrome DevTools MCP), verified several things live against the real account rather than from static captures — much higher confidence than anything above.

### EVSID: how the EVS session is actually established (critical fix)

Everything in "Second app surface" above assumed the EVS host accepts the same cookie as `www.idrive.com`. **This is wrong.** Verified by curl: calling `evs/listDevices` with a full, valid `www.idrive.com` cookie (SES_TOKEN, JSESSIONID, EVS_SERVER, etc.) but no `EVSID` returns `{"message":"ERROR","desc":"INVALID PARAMETERS"}` — a 200, not an auth error, but still a failure. The EVS host requires its own `EVSID` cookie, obtained via a distinct handshake:

1. `POST /idrive/home/getnewserver` (on `www.idrive.com`, with a valid session cookie, empty body) → returns text like:
   `\r\n\r\nhttps://<evs-host>/evs/tokenLogin?token=<token>&sid=<sid>&rm=null&content_type=img$<evs-host>`
   (Split on `$`: everything before is a URL, everything after is the bare EVS host — matches `EVS_SERVER`.)
2. `GET` that `evs/tokenLogin?...` URL (no cookies needed at all — verified with a completely empty cookie jar) → response is `Content-Type: image/jpeg` (disguised as an image so the real app can fire it via an `<img>` tag for a cross-domain cookie-set, per its own JS) and carries `Set-Cookie: EVSID=<value>; SameSite=none; HttpOnly; Secure`.
3. Every subsequent `/evs/*` call just needs `Cookie: EVSID=<value>` — verified end-to-end: a cookie jar containing *only* the freshly-minted `EVSID` (no `www.idrive.com` cookies at all) successfully called `evs/listDevices` and got real data back.

**Implication for the client**: `IdriveClient`'s EVS methods need to run this handshake (once, caching the result) instead of forwarding the configured `IDRIVE_COOKIE` string to the EVS host. The `www.idrive.com` cookie (specifically a valid `SES_TOKEN`/session) is still required as the *first* step (`getnewserver` needs it), so `IDRIVE_COOKIE` alone is still sufficient input — the client just needs to do more with it.

### Corrected `evs/browseFolder` request shape

Live-captured via DevTools network inspection (ground truth, more reliable than the earlier HAR-derived "double leading slash" reading, which was likely an artifact of double-decoding in this project's own HAR-parsing script): the real form body is
`p=/C/AMD/Support/.../Config` (**single** leading slash, not `//C`), plus `json=yes`, **`devices=yes`** (a field not seen in the earlier HAR-derived version), and `device_id`. The existing `browse_folder` tool needs correcting on both points.

### `POST https://<evs-host>/evs/listDevices` — simpler device list (CONFIRMED, supersedes `getListDevicesForSub`)
Form: `json=yes` — **no username/account-email field needed at all**, unlike the `idriveent` version. Response is identical shape to `getListDevicesForSub`'s `contents` array. Since this lives on the real `/idrive/home` surface the user actually uses (matching the very first example curl), prefer this over `idriveent`'s version going forward.

### `POST https://<evs-host>/evs/downloadFile` — CONFIRMED, download a file's actual content
Form: `p` (file path, e.g. `/C/AMD/.../licensePLK.txt`), `json=yes`, `device_id`. **The response body IS the raw file content** (verified on a small text file — response bytes matched the file's real content, UTF-16-encoded text in this case; presumably raw bytes for any file type, `Content-Type` is unreliable — always `text/plain;charset=UTF-8` regardless of actual file type, so must be treated as an opaque byte stream, not trusted for type detection). No separate "prepare/poll/fetch" step — a single call returns the whole file. This is different from what the user's browser actually does when they click "download" in the UI (see below) but is far better suited to programmatic use.

### The UI's actual download flow (why the original HAR captures never saw it)
Confirmed from the app bundle (`All-Compressed-Idrive.js`): clicking "download" in the UI calls `POST /idrive/home/trusted/checkWEBip` first (trust check), then does `window.open("https://<evs-host>/evs/v1/downloadFile?version=0&p=<encoded path>&device_id=<id>", "_blank")` — a **new-tab navigation**, not an XHR/fetch. Chrome DevTools' Network panel only records the tab it's attached to, so this download never appeared in any of the HARs the user exported from the original tab — confirmed the diagnosis given earlier in this session. `evs/downloadFile` (above) is the better-suited endpoint for this MCP server; `v1/downloadFile` is documented here for completeness but not needed.

### `POST https://<evs-host>/evs/getProperties` — CONFIRMED, file/folder metadata
Form: same `p`/`json`/`device_id` pattern. Response: `{"path","message":"SUCCESS","size","lmd","lmd_web"}`. Matches the "Folder size / File count / Modified date" info dialog seen in the UI (that dialog likely adds a file count for folders — untested on a folder target).

### `POST https://<evs-host>/evs/getVersions` — CONFIRMED shape (error case), name matches earlier `idriveent` guess
Same `p`/`json`/`device_id` form. Confirmed response shape for the "nothing to show" case: `{"path","message":"ERROR","desc":"NO FILE VERSIONS FOUND"}`. The success-case shape (a file with actual prior versions) is still unconfirmed — need a live test against a file that has more than one backed-up version.

### Full endpoint inventory from the live app bundle (names only — NOT verified shapes except where marked above)
Extracted directly from `https://static.idriveonlinebackup.com/idrive/include/scripts/min/All-Compressed-Idrive.js` (the actual `/idrive/home` app's main script). High-value ones for this project's remaining scope:

- **Create/rename/move/copy**: `evs/createFolder`, `evs/renameFileFolder`, `evs/move`, `evs/copyPasteFileFolder`, `/idrive/home/rename`, `/idrive/home/renameFileFolderEvent`, `/idrive/home/createFolderEvent`, `/idrive/home/cutCopyEvent`
- **Delete/trash**: `evs/v1/deleteFile`, `evs/putBackFromTrash`, `evs/v1/emptyTrash`, `/idrive/home/fileDeleteEvent`, `/idrive/home/putBackEvent`, `/idrive/home/emptyTrashEvent`, `/idrive/trash`, `/idrive/idriveTrash`
- **Sharing**: `/idrive/home/filesingleshare`, `/idrive/sh/generateShare`, `/idrive/sh/sh`, `/idrive/home/idsharesinglelinkupdates`, `/idrive/home/updateEventShare`, `/idrive/shareHistory`, `/idrive/shareHistory/sharedWithMe`, `/idrive/viewjsp/idShareSingleLinkSendMail`, `/idrive/viewjsp/idShareFromApplication`
- **Search**: `evs/searchFiles`
- **Versions**: `/idrive/home/setFileVersion` (restore a specific version — pairs with `evs/getVersions`)
- **Device management**: `/idrive/home/renameDeviceFolder`, `evs/updateNickname`, `/idrive/remote/deleteCompwithData` (delete a device + its backed-up data — destructive, high caution)
- **Account/usage**: `/idrive/home/account` (likely the storage/usage page — still needs a live capture to confirm shape)
- **CSRF**: `/idrive/home/getCSRFToken` (this surface's CSRF token endpoint, distinct from `idriveent`'s `csrf/get-token`)
- **Cloud-to-cloud (real, not just pricing!)**: `facebookBackup`/`importFB`/`deleteFBToken`/`trackFBImport`, `instagramBackup`/`importInstagram`/`retrieveToken`, `googleAccessToken`, `yahooAccessToken`, plus backed-up-data listing endpoints `calendarEventslist(Version)`, `contactlist(Version)`, `smslist(Version)`, `callLogslist(Version)` — this is the actual answer to the earlier open "cloud-to-cloud" scope item, much richer than the pricing-only endpoint found before.
- **Sub-accounts**: `/idrive/subaccounts/getSubAccountProfile`, `/idrive/subaccounts/getSubaccountsList`, `/idrive/home/createsubaccount`, `/idrive/home/editsubaccount`

**Important open question before building create/rename/move/delete/share tools**: the account's home page UI includes an explicit "Sync" folder area, separate from the per-device Backup browser ("All the web uploads will be available only in the Sync folder. Proceed to the 'Sync' area to upload your files.") — it's plausible create-folder/rename/move/upload/share only make semantic sense (and may only be *implemented* to work) within that Sync area, not within a device's read-only backup tree (`/C/AMD/...` etc.). Needs confirmation before assuming these endpoints work against arbitrary backup paths.

## Live mutation testing (2026-08-26/27, on a throwaway `MCP_API_TEST_FOLDER`)

With explicit user go-ahead, created a test folder (`ACRESSWELL01-D`, `/C/MCP_API_TEST_FOLDER`) and exercised create/delete/restore against it directly (never touching real files), then cleaned up by moving it back to trash at the end. All calls below go to `https://<evs-host>` and use the same `EVSID`-bootstrapped session as everything else in "Live browser session findings".

### `POST /evs/createFolder` — CONFIRMED
Form: `foldername` (new folder's name, not a path), `p` (parent path, e.g. `/C`), `json=yes`, `device_id`. Response on success: `{"message":"SUCCESS","desc":"FOLDER CREATED SUCCESSFULLY"}`. Verified the folder actually appears in a subsequent `browseFolder` call with real metadata. **Confirms create-folder works directly inside a device's backup tree**, not just a separate Sync area — the user's own usage pattern.

### `POST /evs/v1/deleteFile` — CONFIRMED (move to trash)
Form: `trash` (`yes` to move to trash, presumably `no` for permanent delete — only `yes` tested), one or more `p` fields (repeat the field for multiple items, per source: `p=<path1>&p=<path2>&...`), `json=yes`, `device_id`. Response: `{"message":"SUCCESS","contents":[{"path":"<path>","result":"SUCCESS"}]}` (one entry per deleted `p`). Verified the item actually disappeared from a subsequent `browseFolder` listing.

### `POST /evs/putBackFromTrash` — CONFIRMED (restore from trash)
Form: same repeatable `p` pattern, `json=yes`, `device_id`. Response: `{"message":"SUCCESS","contents":[{"path":"<path>","result":"SUCCESS"}]}`. Verified the item reappeared in `browseFolder`.

### Trash **listing** — still unresolved
No dedicated "list trash" `/evs/*` endpoint was found by static analysis, and `browseFolder` with an added `trash=yes` field returns `{"message":"ERROR","desc":"INVALID PATH"}` for both `/C` and `/` — that's not the right mechanism. The app has dedicated page routes (`/idrive/trash`, `/idrive/idriveTrash`) that presumably lazy-load their own JS bundle with the real listing call; not yet captured. So: you can delete-to-trash and restore-from-trash by path (if you already know what's there), but there's no confirmed way yet to enumerate what's currently in trash.

### `POST /evs/renameFileFolder` — ATTEMPTED, NOT YET WORKING
Per source: form `oldpath`, `newpath` (both full paths, e.g. `/C/MCP_API_TEST_FOLDER` → `/C/MCP_API_TEST_FOLDER_RENAMED`), `json=yes` (`device_id` auto-injected by the app's request wrapper for any `/evs/*` call, confirmed by reading `makeRequestFn`'s source — but adding it explicitly made no difference). Every real attempt (with and without explicit `device_id`, with and without an added `p` field) returned `{"message":"ERROR","desc":"Rename failed."}` — a generic failure, not a params/auth error, so the request reached the handler but was rejected for an unknown reason. Untested hypothesis: rename might behave differently for folders vs. files, or might need the item to be represented in a specific state (e.g. actually re-verify against a plain **file** rather than a folder, or against an item that isn't itself a same-session creation). Needs another live session to dig further — not implemented as a tool yet given the uncertainty.

### `evs/move`, `evs/copyPasteFileFolder`, sharing endpoints — NOT YET TESTED
Ran out of easy remaining test surface this session (a move/share test risks a similar unresolved-failure loop without more time). Endpoint names are confirmed from source (see the full inventory in "Live browser session findings" above); shapes are not.

### Account/storage usage — CONFIRMED, but via HTML scraping, not a clean API
No dedicated JSON "usage" endpoint exists. `GET /idrive/home/account.html` returns a full HTML page with the quota embedded as inline `<script>` variables: `var syncUsedQuota = "0.00 KB"; var syncTotalQuota = "5000.00 GB";` (this account's real values). No separate non-sync/backup quota variable was found on this page — either the plan's quota is unified across sync+backup, or a per-device-backup figure lives somewhere else not yet found. A `get_account_usage` tool would need to fetch this HTML and regex out those two `var` declarations — fragile to markup/variable-name changes, but it's the only confirmed source right now.

## Still needed

Resolved this session: downloading a file's content, the EVS session bootstrap, file properties, the "no versions" shape of `getVersions`, create-folder, delete-to-trash, restore-from-trash, and account storage quota (via HTML scrape). Confirmed create/delete/restore all work directly inside a device's backup tree (the user's actual usage pattern), not just a separate Sync area. Still open:
1. **Why `renameFileFolder` fails** — reaches the handler (not a params/auth error) but returns a generic `"Rename failed."`; needs more live investigation (see hypothesis above), or trying it against a file instead of a folder.
2. **Move** (`evs/move`) and **copy** (`evs/copyPasteFileFolder`) — names confirmed from source, not yet live-tested.
3. **Listing what's in trash** — no endpoint found yet; delete-to-trash and restore-from-trash both work by path if you already know it, but there's no confirmed enumeration call.
4. The success-case shape of **version history** (`evs/getVersions`) — only the empty/error case is confirmed; need a live test against a file with multiple backed-up versions, plus `setFileVersion`'s shape for restoring a specific one.
5. **Sharing** — `/idrive/sh/generateShare` and related endpoints (see the full inventory above), not yet live-tested.
6. Browsing an actual **cloud-to-cloud connected account** — now that real endpoint names are known (`facebookBackup`, `contactlist`, `calendarEventslist`, etc.), this needs the user to have a connected source and a live test against it; the earlier c2c endpoint found was pricing/upsell only.
