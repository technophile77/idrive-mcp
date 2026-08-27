import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { IdriveClient, SessionExpiredError } from "../client/idriveClient.js";
import type { AccountFeatureFlags, AccountUsage, CloudBackupPlan } from "../types/account.js";

const ACCOUNT_USAGE_PATH = "/idrive/home/account.html";

/**
 * Wraps a zero-argument tool's JSON result in the MCP `content` shape every
 * tool callback must return, so each tool below only has to produce its raw
 * response value.
 *
 * @param data the value to serialize as the tool's text content.
 * @returns a successful `CallToolResult` carrying `data` as JSON text.
 */
function jsonResult(data: unknown): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(data) }],
  };
}

/**
 * Builds the MCP error result for an expired iDrive session, so every tool
 * in this module surfaces the same actionable message instead of letting a
 * `SessionExpiredError` fail with a generic error result.
 *
 * @param error the caught session-expiry error.
 * @returns an error `CallToolResult` telling the caller to refresh
 *   `IDRIVE_COOKIE`.
 */
function sessionExpiredResult(error: SessionExpiredError): CallToolResult {
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: `Your iDrive session has expired — refresh IDRIVE_COOKIE. (${error.message})`,
      },
    ],
  };
}

/**
 * Extracts the account's Sync storage quota out of the raw HTML of
 * `GET /idrive/home/account.html`, by regex-matching the two inline
 * `<script>` variable declarations iDrive embeds in the page
 * (`var syncUsedQuota = "...";` and `var syncTotalQuota = "...";`) — there is
 * no dedicated JSON usage endpoint (see `docs/api-map.md`'s "Account/storage
 * usage" section), so this HTML scrape is the only confirmed source of this
 * data right now. It's inherently fragile: any change to the page's markup
 * or these variable names would silently break it, which is why this never
 * throws and instead returns `null` for the caller to turn into a clear
 * "couldn't parse" tool error rather than a crash or a guessed value.
 *
 * @param html the raw HTML response body of `GET /idrive/home/account.html`.
 * @returns the two quota values exactly as they appear in the page (e.g.
 *   `"0.00 KB"`, `"5000.00 GB"` — free-form strings with a unit suffix, not
 *   parsed into a number), or `null` if either `var` declaration isn't
 *   present (e.g. iDrive changed the page).
 * @example
 * ```ts
 * extractAccountUsage(
 *   '...<script>var syncUsedQuota = "0.00 KB"; var syncTotalQuota = "5000.00 GB";</script>...',
 * );
 * // => { syncUsedQuota: "0.00 KB", syncTotalQuota: "5000.00 GB" }
 * ```
 * @example
 * ```ts
 * extractAccountUsage("<html><body>no quota script here</body></html>"); // => null
 * ```
 * @see AccountUsage
 * @see get_account_usage
 */
export function extractAccountUsage(html: string): AccountUsage | null {
  const usedMatch = html.match(/var\s+syncUsedQuota\s*=\s*"([^"]*)"/);
  const totalMatch = html.match(/var\s+syncTotalQuota\s*=\s*"([^"]*)"/);
  if (usedMatch === null || totalMatch === null) {
    return null;
  }

  return { syncUsedQuota: usedMatch[1], syncTotalQuota: totalMatch[1] };
}

/**
 * Registers the read-only account/plan information tools backed by
 * confirmed iDrive endpoints (`docs/api-map.md`): account feature flags,
 * the raw dashboard payload, cloud-to-cloud plan pricing, and (via HTML
 * scraping, see {@link extractAccountUsage}) Sync storage usage. None of
 * these tools take input parameters.
 *
 * @param server the MCP server to register tools on.
 * @param client the shared iDrive HTTP client used to call the endpoints.
 * @example
 * ```ts
 * const server = new McpServer({ name: "idrive-mcp-server", version: "0.1.0" });
 * registerAccountTools(server, new IdriveClient(loadConfig().cookie));
 * ```
 */
export function registerAccountTools(server: McpServer, client: IdriveClient): void {
  server.registerTool(
    "get_account_features",
    {
      title: "Get account feature flags",
      description:
        "Returns the boolean feature flags iDrive uses to decide which product sections " +
        "(e.g. Remote PC, E2 object storage, 360 backup) show in the web console's left nav " +
        "for this account. The exact set of keys isn't guaranteed stable across accounts — " +
        "treat this as a loose flag bag, not a fixed schema.",
    },
    async (): Promise<CallToolResult> => {
      try {
        const flags = (await client.get("/idrive/home/products/account/exists")) as AccountFeatureFlags;
        return jsonResult(flags);
      } catch (error) {
        if (error instanceof SessionExpiredError) {
          return sessionExpiredResult(error);
        }
        throw error;
      }
    },
  );

  server.registerTool(
    "get_dashboard",
    {
      title: "Get raw dashboard payload",
      description:
        "Returns the raw JSON from iDrive's user dashboard endpoint, as-is. Its response " +
        "shape is unmapped and unconfirmed — in the one captured session so far it returned " +
        "an empty array. Callers should treat the result as opaque diagnostic data and must " +
        "not rely on any specific field being present.",
    },
    async (): Promise<CallToolResult> => {
      try {
        const dashboard: unknown = await client.get("/idriveent/user/getDashboard");
        return jsonResult(dashboard);
      } catch (error) {
        if (error instanceof SessionExpiredError) {
          return sessionExpiredResult(error);
        }
        throw error;
      }
    },
  );

  server.registerTool(
    "get_cloud_backup_plan",
    {
      title: "Get cloud-to-cloud plan pricing",
      description:
        "Returns iDrive's cloud-to-cloud (c2c) product tier pricing/upsell info (current plan, " +
        "monthly/yearly price, any active offer or promo code). This is billing information " +
        "only — it does NOT list the user's actual connected cloud accounts (Google Drive, " +
        "iCloud, etc.) or their backed-up data; no endpoint for that has been discovered yet " +
        "(see docs/api-map.md, 'Still needed from you' item 6).",
    },
    async (): Promise<CallToolResult> => {
      try {
        const plan = (await client.get("/idrive/home/c2c/custom/plan/user")) as CloudBackupPlan;
        return jsonResult(plan);
      } catch (error) {
        if (error instanceof SessionExpiredError) {
          return sessionExpiredResult(error);
        }
        throw error;
      }
    },
  );

  server.registerTool(
    "get_account_usage",
    {
      title: "Get account storage usage (Sync quota)",
      description:
        "Returns the account's used and total Sync storage quota. There is no dedicated JSON usage " +
        "endpoint for this — it's scraped from two inline <script> variables on iDrive's account.html page " +
        "(see docs/api-map.md's 'Account/storage usage' section), so this tool is inherently fragile: a " +
        "change to that page's markup or variable names could silently break it (it fails with a clear " +
        "tool error in that case, rather than a crash or a guessed value). Values are returned as raw, " +
        "free-form strings with their unit suffix (e.g. \"0.00 KB\", \"5000.00 GB\"), not parsed into " +
        "numbers. This reflects the page's own 'Sync' quota naming specifically — whether it also " +
        "represents total usage across device backups (not just the Sync area) is unconfirmed.",
    },
    async (): Promise<CallToolResult> => {
      try {
        const body = await client.get(ACCOUNT_USAGE_PATH);
        const usage = typeof body === "string" ? extractAccountUsage(body) : null;
        if (usage === null) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text:
                  "Couldn't parse account storage usage from iDrive's account page — its markup or " +
                  "variable names may have changed (see docs/api-map.md's 'Account/storage usage' section).",
              },
            ],
          };
        }

        return jsonResult(usage);
      } catch (error) {
        if (error instanceof SessionExpiredError) {
          return sessionExpiredResult(error);
        }
        throw error;
      }
    },
  );
}
