/**
 * A single file or folder entry as returned by iDrive's `getRestoreData`
 * endpoint when browsing a device's backed-up file tree. Field names and
 * string-typed numbers/booleans are kept verbatim from the wire response
 * (see `docs/api-map.md`'s `getRestoreData` entry) rather than normalized,
 * since several fields (`size`, `ver`, `attrib_star`) use `"-"` as a sentinel
 * for "not applicable" rather than a numeric value.
 *
 * @example
 * ```ts
 * const entry: FileEntry = {
 *   split_backup: "0",
 *   is_dir: true,
 *   name: "E",
 *   size: "-",
 *   ver: "-",
 *   lmd: "2021/11/23 12:44:40",
 *   lmd_web: "1637700280",
 *   thumb_exists: false,
 *   attrib_star: "0",
 *   attrib_desc: "-",
 *   share: "-",
 *   capture_date: "0",
 *   save_time: "2021/11/23 12:44:40",
 * };
 * ```
 */
export type FileEntry = {
  /** Whether this entry is a directory (`true`) or a file (`false`). */
  is_dir: boolean;
  /** The entry's file or folder name (not a full path). */
  name: string;
  /** File size in bytes as a string, or `"-"` for directories/unknown. */
  size: string;
  /** Backup version identifier as a string, or `"-"` when not applicable. */
  ver: string;
  /** Last-modified date/time, formatted `YYYY/MM/DD HH:mm:ss`. */
  lmd: string;
  /** Last-modified date/time as a Unix timestamp string (seconds). */
  lmd_web: string;
  /** Whether a thumbnail preview is available for this entry. */
  thumb_exists: boolean;
  /** Whether the entry is starred/favorited (`"1"`) or not (`"0"`). */
  attrib_star: string;
  /** User-supplied description attribute, or `"-"` when unset. */
  attrib_desc: string;
  /** Sharing status; observed as always `"-"` (unconfirmed if ever populated). */
  share: string;
  /** Backup capture date, or `"0"` when not applicable. */
  capture_date: string;
  /** Timestamp this backup version was saved, formatted `YYYY/MM/DD HH:mm:ss`. */
  save_time: string;
  /** Whether this backup was split across multiple parts (`"1"`) or not (`"0"`). */
  split_backup: string;
};

/**
 * The parsed response shape of a successful `getRestoreData` call — a
 * directory listing for one folder in a device's backed-up file tree.
 *
 * @see FileEntry
 */
export type RestoreDataResponse = {
  message: string;
  path: string;
  contents: FileEntry[];
};

/**
 * A single file or folder entry as returned by iDrive's `evs/browseFolder`
 * endpoint (see `docs/api-map.md`'s "Second app surface" section) — the same
 * fields as {@link FileEntry} plus a handful more that only appear on this
 * richer, EVS-hosted listing. The extra fields are marked optional even
 * though every observed response included them, since only one capture has
 * confirmed their presence and the API's own consistency across item types
 * (files vs. folders, different devices) is otherwise unverified.
 *
 * @example
 * ```ts
 * const entry: BrowseFolderEntry = {
 *   is_dir: false,
 *   name: "PackageSubType.Dat",
 *   size: "10517",
 *   ver: "1",
 *   lmd: "2014/01/24 22:50:22",
 *   lmd_web: "1390632622",
 *   thumb_exists: false,
 *   attrib_star: "0",
 *   attrib_desc: "-",
 *   share: "-",
 *   capture_date: "-",
 *   save_time: "2021/11/18 14:31:01",
 *   split_backup: "0",
 *   in_trash: "0",
 *   chk: "NA",
 *   live_image: "0",
 *   wlib: "0",
 * };
 * ```
 * @see FileEntry
 */
export type BrowseFolderEntry = FileEntry & {
  /** Whether the entry is currently in the trash (`"1"`) or not (`"0"`) — a real, populated field here, unlike `getRestoreData`'s `share`. */
  in_trash?: string;
  /** Checksum or integrity marker; observed as always `"NA"` (unconfirmed if ever populated). */
  chk?: string;
  /** Whether the entry is a "live" (in-progress capture) image (`"1"`) or not (`"0"`); meaning otherwise unconfirmed. */
  live_image?: string;
  /** Unconfirmed purpose; observed as always `"0"`. */
  wlib?: string;
};

/**
 * The parsed response shape of a successful `evs/browseFolder` call — a
 * directory listing for one folder in a device's backed-up file tree, richer
 * than {@link RestoreDataResponse}.
 *
 * @see BrowseFolderEntry
 */
export type BrowseFolderResponse = {
  message: string;
  path: string;
  contents: BrowseFolderEntry[];
};

/**
 * The parsed response shape of a successful `evs/getProperties` call —
 * file/folder metadata (size, last-modified date) for a single backed-up
 * path (see `docs/api-map.md`'s "Live browser session findings" section).
 * Matches the "Folder size / File count / Modified date" info dialog seen in
 * iDrive's own UI, though whether a folder target adds a file-count field is
 * untested.
 *
 * @example
 * ```ts
 * const properties: FilePropertiesResponse = {
 *   path: "/C/AMD/Support/licensePLK.txt",
 *   message: "SUCCESS",
 *   size: "1024",
 *   lmd: "2021/11/18 14:31:01",
 *   lmd_web: "1637245861",
 * };
 * ```
 * @see get_file_properties
 */
export type FilePropertiesResponse = {
  path: string;
  message: string;
  size: string;
  lmd: string;
  lmd_web: string;
};

/**
 * The confirmed response shape of `evs/getVersions` when a file has no
 * backed-up version history — the only shape observed so far (see
 * `docs/api-map.md`'s "Live browser session findings" section). The
 * `message: "SUCCESS"` shape for a file that *does* have prior versions has
 * never been observed and is intentionally left unmodeled — see
 * `get_file_versions`'s DocBlock for how the tool handles that case.
 *
 * @example
 * ```ts
 * const noVersions: NoFileVersionsResponse = {
 *   path: "/C/AMD/Support/licensePLK.txt",
 *   message: "ERROR",
 *   desc: "NO FILE VERSIONS FOUND",
 * };
 * ```
 * @see get_file_versions
 */
export type NoFileVersionsResponse = {
  path: string;
  message: "ERROR";
  desc: "NO FILE VERSIONS FOUND";
};

/**
 * The confirmed response shape of a successful `evs/createFolder` call (see
 * `docs/api-map.md`'s "Live mutation testing" section) — iDrive doesn't echo
 * back the created path, just a fixed success message pair.
 *
 * @example
 * ```ts
 * const response: CreateFolderResponse = { message: "SUCCESS", desc: "FOLDER CREATED SUCCESSFULLY" };
 * ```
 * @see create_folder
 */
export type CreateFolderResponse = {
  message: string;
  desc?: string;
};

/**
 * A single path's outcome within a batch `evs/v1/deleteFile` or
 * `evs/putBackFromTrash` call — one entry per `p` field sent in the request
 * (see `docs/api-map.md`'s "Live mutation testing" section).
 *
 * @example
 * ```ts
 * const entry: PathOperationResult = { path: "/C/MCP_API_TEST_FOLDER", result: "SUCCESS" };
 * ```
 * @see delete_file
 * @see restore_from_trash
 */
export type PathOperationResult = {
  path: string;
  result: string;
};

/**
 * The confirmed response shape of a successful `evs/v1/deleteFile` or
 * `evs/putBackFromTrash` call — a per-path result array, since both
 * endpoints accept multiple `p` fields in a single batch request (see
 * `docs/api-map.md`'s "Live mutation testing" section).
 *
 * @example
 * ```ts
 * const response: PathOperationResponse = {
 *   message: "SUCCESS",
 *   contents: [{ path: "/C/MCP_API_TEST_FOLDER", result: "SUCCESS" }],
 * };
 * ```
 * @see delete_file
 * @see restore_from_trash
 */
export type PathOperationResponse = {
  message: string;
  contents: PathOperationResult[];
};
