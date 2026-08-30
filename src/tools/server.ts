import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { getServerVersion } from "../version.js";

/**
 * Wraps a zero-argument tool's JSON result in the MCP `content` shape every
 * tool callback must return, so this tool's response mirrors the same
 * `jsonResult` pattern used by `src/tools/account.ts`.
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
 * Registers the `get_server_version` tool, which reports exactly which
 * build of this MCP server is currently running (see {@link getServerVersion})
 * — this project doesn't bump `package.json`'s `version` on every fix, so
 * two running builds can share the same semver, and a stale server process
 * left running after a code change is otherwise indistinguishable from a
 * freshly restarted one until something breaks. This tool makes that
 * checkable directly from inside a conversation, regardless of whether the
 * connecting MCP host surfaces the `serverInfo.version` field from the
 * initialize handshake.
 *
 * @param server the MCP server to register the tool on.
 * @example
 * ```ts
 * const server = new McpServer({ name: "idrive-mcp-server", version: getServerVersion().displayVersion });
 * registerServerTools(server);
 * // client can now call the "get_server_version" tool
 * ```
 */
export function registerServerTools(server: McpServer): void {
  server.registerTool(
    "get_server_version",
    {
      title: "Get server version",
      description:
        "Reports exactly which build of this MCP server is currently running: the package.json " +
        "version, a git commit descriptor (short hash, plus a dirty-working-tree indicator) for the " +
        "checked-out source, and a combined human-readable display string. Exists to tell a stale, " +
        "already-running server process apart from the current build — this project doesn't bump " +
        "package.json's version on every fix, so semver alone can't distinguish them. This is purely " +
        "local diagnostic info: it doesn't call iDrive's API.",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async (): Promise<CallToolResult> => jsonResult(getServerVersion()),
  );
}
