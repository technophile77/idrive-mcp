import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { IdriveClient, MissingEvsServerError, SessionExpiredError } from "../client/idriveClient.js";
import { deviceSchema, type Device } from "../types/device.js";

/**
 * The `evs/listDevices` endpoint path (see `docs/api-map.md`'s "Live browser
 * session findings" section) — the real `/idrive/home` surface's device
 * list, superseding the older `idriveent`-console `getListDevicesForSub`
 * endpoint this tool used to call (same response shape, simpler request, no
 * account-email field needed).
 */
const LIST_DEVICES_PATH = "/evs/listDevices";

/** Zod schema for the raw `evs/listDevices` response envelope. */
const listDevicesResponseSchema = z.object({
  contents: z.array(deviceSchema),
});

/**
 * Validates and unwraps the raw `evs/listDevices` response into its device
 * list — exists so the tool handler doesn't trust unvalidated network JSON,
 * and so a shape change in the upstream API surfaces as a clear error
 * instead of a confusing downstream `undefined`.
 *
 * @param response the parsed JSON body returned by `IdriveClient.requestEvs`.
 * @returns the list of devices from the response's `contents` field.
 * @throws {Error} if `response` doesn't match the expected
 *   `{ contents: Device[] }` shape.
 * @example
 * ```ts
 * parseDeviceListResponse({ contents: [] }); // => []
 * ```
 */
function parseDeviceListResponse(response: unknown): Device[] {
  const result = listDevicesResponseSchema.safeParse(response);
  if (!result.success) {
    throw new Error(
      `Unexpected response shape from ${LIST_DEVICES_PATH}: ${result.error.message}`,
    );
  }

  return result.data.contents;
}

/**
 * Builds an MCP tool error result carrying a human-readable message — exists
 * so every failure path in this file (expired session, missing EVS_SERVER
 * cookie value) reports the same shape instead of throwing uncaught.
 *
 * @param message the error text to surface to the MCP client.
 * @returns a `CallToolResult` with `isError: true`.
 */
function toolError(message: string): CallToolResult {
  return {
    content: [{ type: "text", text: message }],
    isError: true,
  };
}

/**
 * Registers the `list_devices` tool, which lists every device backed up
 * under the authenticated iDrive account (device ID, OS, nickname, IP, and
 * backup bucket location) — the read-only counterpart to the account's
 * "Remote Management" device list in the iDrive web console.
 *
 * @param server the MCP server to register the tool on.
 * @param client the shared iDrive HTTP client, already bound to the
 *   configured session cookie.
 * @example
 * ```ts
 * const server = new McpServer({ name: "idrive-mcp-server", version: "0.1.0" });
 * registerDeviceTools(server, new IdriveClient(loadConfig().cookie));
 * // client can now call the "list_devices" tool
 * ```
 */
export function registerDeviceTools(server: McpServer, client: IdriveClient): void {
  server.registerTool(
    "list_devices",
    {
      title: "List iDrive devices",
      description:
        "Lists every device backed up under the authenticated iDrive account, " +
        "including each device's ID, operating system, nickname, IP address, " +
        "and backup bucket location.",
      outputSchema: { devices: z.array(deviceSchema) },
    },
    async (): Promise<CallToolResult> => {
      try {
        const response = await client.requestEvs(LIST_DEVICES_PATH, { json: "yes" });
        const devices = parseDeviceListResponse(response);

        return {
          content: [{ type: "text", text: JSON.stringify(devices, null, 2) }],
          structuredContent: { devices },
        };
      } catch (error) {
        if (error instanceof SessionExpiredError) {
          return toolError(
            "Your iDrive session has expired — refresh IDRIVE_COOKIE with a new Cookie " +
              "header value from a logged-in idrive.com browser session.",
          );
        }
        if (error instanceof MissingEvsServerError) {
          return toolError(error.message);
        }
        throw error;
      }
    },
  );
}
