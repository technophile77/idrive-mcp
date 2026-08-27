import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { IdriveClient } from "./client/idriveClient.js";
import { registerAccountTools } from "./tools/account.js";
import { registerDeviceTools } from "./tools/devices.js";
import { registerFileTools } from "./tools/files.js";

const SERVER_NAME = "idrive-mcp-server";
const SERVER_VERSION = "0.1.0";

/**
 * Starts the iDrive MCP server: validates config, wires up the shared iDrive
 * HTTP client, and connects the stdio transport so an MCP host (e.g. Claude
 * Desktop or Claude Code) can talk to it over stdin/stdout.
 *
 * @throws {Error} if `IDRIVE_COOKIE` is missing or empty — surfaced here so
 *   startup fails fast with a clear message instead of failing on the first
 *   tool call.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const idriveClient = new IdriveClient(config.cookie);

  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
  });

  registerAccountTools(server, idriveClient);
  registerDeviceTools(server, idriveClient);
  registerFileTools(server, idriveClient);

  // TODO: register remaining tools from src/tools/*.ts here

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
