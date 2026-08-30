import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The directory this module lives in — `src/` in a `tsx`/dev checkout,
 * `dist/` in a compiled build. Both mirror the project root's flat top-level
 * layout, so `../package.json` and `..` (the project root) resolve
 * correctly from either location.
 */
const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

/** Absolute path to the project root, i.e. the directory `package.json` lives in. */
const PROJECT_ROOT = join(MODULE_DIR, "..");

/** Absolute path to the project's `package.json`, read for its `version` field. */
const PACKAGE_JSON_PATH = join(PROJECT_ROOT, "package.json");

/**
 * The exact identity of the running server build, combining `package.json`'s
 * `version` field with a git commit descriptor for the checked-out source —
 * see {@link getServerVersion}.
 */
export interface ServerVersionInfo {
  /** The `version` field from `package.json` (e.g. `"0.1.0"`). */
  packageVersion: string;
  /**
   * The output of `git describe --always --dirty --broken` for the checked-out
   * `HEAD` (e.g. `"4acdcfa"`, or `"4acdcfa-dirty"` with uncommitted changes),
   * or `null` if it couldn't be determined (no git installed, not a git
   * checkout, or the command failed for any other reason).
   */
  gitDescriptor: string | null;
  /**
   * A single human-readable string combining both fields above, suitable for
   * display as-is (e.g. `"0.1.0 (git 4acdcfa)"`, or just `"0.1.0"` when
   * `gitDescriptor` is `null`).
   */
  displayVersion: string;
}

/**
 * Reads the `version` field out of the project's `package.json`, so the
 * server's reported version always matches the package it was built from
 * instead of a separately hand-maintained constant.
 *
 * @returns the package's `version` string, or the literal `"0.0.0-unknown"`
 *   if `package.json` is missing, unreadable, or has no string `version`
 *   field. Never throws — this runs at module load time, and a broken
 *   `package.json` shouldn't be able to crash server startup just to report
 *   a version string.
 * @see readGitDescriptor
 */
function readPackageVersion(): string {
  try {
    const raw = readFileSync(PACKAGE_JSON_PATH, "utf8");
    const parsed: unknown = JSON.parse(raw);
    const version = (parsed as { version?: unknown }).version;
    return typeof version === "string" && version.length > 0 ? version : "0.0.0-unknown";
  } catch {
    return "0.0.0-unknown";
  }
}

/**
 * Runs `git describe --always --dirty --broken` against the checked-out
 * source to get a short, human-readable descriptor of exactly which commit
 * (and whether the working tree has uncommitted changes) the running build
 * came from — this is what lets `displayVersion` distinguish two builds
 * that share the same `package.json` version (this project doesn't bump
 * semver on every fix).
 *
 * @returns the trimmed git descriptor (e.g. `"4acdcfa"`, `"4acdcfa-dirty"`),
 *   or `null` if it can't be determined — git isn't installed, the project
 *   isn't a git checkout (e.g. a packaged/zipped deployment with no `.git`
 *   directory), or the command fails for any other reason. Never throws:
 *   this is best-effort diagnostic info, not something worth failing server
 *   startup over.
 * @see readPackageVersion
 */
function readGitDescriptor(): string | null {
  try {
    const output = execFileSync("git", ["describe", "--always", "--dirty", "--broken"], {
      cwd: PROJECT_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();

    return output.length > 0 ? output : null;
  } catch {
    return null;
  }
}

/**
 * The server's version info, computed once at module load — it can't change
 * while the process is running, so there's no reason to re-read
 * `package.json` or re-run `git describe` on every call.
 */
const serverVersionInfo: ServerVersionInfo = (() => {
  const packageVersion = readPackageVersion();
  const gitDescriptor = readGitDescriptor();
  const displayVersion = gitDescriptor === null ? packageVersion : `${packageVersion} (git ${gitDescriptor})`;

  return { packageVersion, gitDescriptor, displayVersion };
})();

/**
 * Returns the exact identity of the running server build — the
 * `package.json` version plus a git commit descriptor for the checked-out
 * source, combined into a single display string. Exists so a running MCP
 * server process (which may be stale relative to the latest compiled
 * `dist/` output — see `docs/api-map.md` or the project README for why this
 * project doesn't bump semver per fix) can be identified precisely from
 * inside a conversation, without manually diffing timestamps or commits.
 *
 * @returns the version info. Never throws — see {@link readPackageVersion}
 *   and {@link readGitDescriptor} for their individual fallback behavior.
 * @example
 * ```ts
 * getServerVersion();
 * // => { packageVersion: "0.1.0", gitDescriptor: "4acdcfa", displayVersion: "0.1.0 (git 4acdcfa)" }
 * ```
 * @see ServerVersionInfo
 */
export function getServerVersion(): ServerVersionInfo {
  return serverVersionInfo;
}
