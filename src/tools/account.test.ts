import { test } from "node:test";
import assert from "node:assert/strict";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { IdriveClient } from "../client/idriveClient.js";
import { extractAccountUsage, registerAccountTools } from "./account.js";

const cookie = process.env.IDRIVE_COOKIE;

/**
 * Wires up a real `McpServer` with the account tools registered, connected
 * to a real `Client` over an in-memory transport pair — exists so each test
 * below exercises the actual MCP `tools/call` protocol path rather than
 * calling the registered handler function directly.
 *
 * @returns a connected MCP `Client` ready to call the account tools.
 */
async function connectTestClient(): Promise<Client> {
  const server = new McpServer({ name: "idrive-mcp-server-test", version: "0.0.0" });
  registerAccountTools(server, new IdriveClient(cookie as string));

  const client = new Client({ name: "idrive-mcp-server-test-client", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  return client;
}

/**
 * Extracts and JSON-parses the text of a successful tool call's first
 * content item — exists so each test doesn't repeat the same content-shape
 * unwrapping.
 *
 * @param result the raw `CallToolResult` returned by `client.callTool`.
 * @returns the parsed JSON value.
 */
function parseFirstTextContent(result: { content?: unknown }): unknown {
  const content = result.content as Array<{ type: string; text: string }>;
  assert.ok(Array.isArray(content) && content.length > 0, "expected at least one content item");
  assert.equal(content[0].type, "text");
  return JSON.parse(content[0].text);
}

test("extractAccountUsage finds both quota variables in a realistic account.html fragment", () => {
  const html =
    "<html><head><script>\n" +
    'var someOtherVar = "irrelevant";\n' +
    'var syncUsedQuota = "0.00 KB";\n' +
    'var syncTotalQuota = "5000.00 GB";\n' +
    "</script></head><body></body></html>";

  assert.deepEqual(extractAccountUsage(html), { syncUsedQuota: "0.00 KB", syncTotalQuota: "5000.00 GB" });
});

test("extractAccountUsage returns null when syncUsedQuota is missing", () => {
  const html = '<script>var syncTotalQuota = "5000.00 GB";</script>';
  assert.equal(extractAccountUsage(html), null);
});

test("extractAccountUsage returns null when syncTotalQuota is missing", () => {
  const html = '<script>var syncUsedQuota = "0.00 KB";</script>';
  assert.equal(extractAccountUsage(html), null);
});

test("extractAccountUsage returns null for HTML with neither variable (e.g. iDrive changed the page)", () => {
  assert.equal(extractAccountUsage("<html><body>no quota data here</body></html>"), null);
});

test("extractAccountUsage: for any random quota-value pair, extraction round-trips exactly", () => {
  const randomQuotaValue = (): string => {
    const amount = (Math.random() * 10_000).toFixed(2);
    const unit = ["KB", "MB", "GB", "TB"][Math.floor(Math.random() * 4)];
    return `${amount} ${unit}`;
  };

  for (let i = 0; i < 50; i++) {
    const used = randomQuotaValue();
    const total = randomQuotaValue();
    const html = `<script>var syncUsedQuota = "${used}"; var syncTotalQuota = "${total}";</script>`;

    assert.deepEqual(extractAccountUsage(html), { syncUsedQuota: used, syncTotalQuota: total });
  }
});

if (!cookie) {
  test("account tools (skipped: IDRIVE_COOKIE not set)", { skip: true }, () => {});
} else {
  test("get_account_features returns a flat boolean flag object", async () => {
    const client = await connectTestClient();
    const result = await client.callTool({ name: "get_account_features" });

    assert.notEqual(result.isError, true, `tool returned an error: ${JSON.stringify(result)}`);
    const flags = parseFirstTextContent(result as { content?: unknown }) as Record<string, unknown>;
    assert.equal(typeof flags, "object");
    for (const value of Object.values(flags)) {
      assert.equal(typeof value, "boolean");
    }
  });

  test("get_dashboard returns whatever JSON the endpoint gives back, without throwing", async () => {
    const client = await connectTestClient();
    const result = await client.callTool({ name: "get_dashboard" });

    assert.notEqual(result.isError, true, `tool returned an error: ${JSON.stringify(result)}`);
    const dashboard = parseFirstTextContent(result as { content?: unknown });
    // Shape is explicitly unmapped/unconfirmed (see docs/api-map.md) — the
    // only meaningful assertion is that the call succeeded and produced
    // JSON-parseable content. Log it for manual inspection.
    console.log("get_dashboard response:", JSON.stringify(dashboard));
  });

  test("get_cloud_backup_plan returns c2c pricing fields", async () => {
    const client = await connectTestClient();
    const result = await client.callTool({ name: "get_cloud_backup_plan" });

    assert.notEqual(result.isError, true, `tool returned an error: ${JSON.stringify(result)}`);
    const plan = parseFirstTextContent(result as { content?: unknown }) as Record<string, unknown>;
    assert.equal(typeof plan.customPlanExists, "boolean");
    assert.equal(typeof plan.plantype, "string");
    assert.equal(typeof plan.plan, "string");
    assert.equal(typeof plan.monthlyprice, "string");
    assert.equal(typeof plan.yearlyprice, "string");
    assert.equal(typeof plan.promocodeExists, "boolean");
  });

  test("get_account_usage returns real Sync quota strings scraped from the account page", async () => {
    const client = await connectTestClient();
    const result = await client.callTool({ name: "get_account_usage" });

    assert.notEqual(result.isError, true, `tool returned an error: ${JSON.stringify(result)}`);
    const usage = parseFirstTextContent(result as { content?: unknown }) as { syncUsedQuota: string; syncTotalQuota: string };
    assert.equal(typeof usage.syncUsedQuota, "string");
    assert.equal(typeof usage.syncTotalQuota, "string");
    assert.ok(usage.syncUsedQuota.length > 0, "expected a non-empty syncUsedQuota string");
    assert.ok(usage.syncTotalQuota.length > 0, "expected a non-empty syncTotalQuota string");
  });
}
