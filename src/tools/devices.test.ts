import { test } from "node:test";
import assert from "node:assert/strict";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { IdriveClient } from "../client/idriveClient.js";
import { extractAccountEmail } from "../client/session.js";
import { registerDeviceTools } from "./devices.js";
import type { Device } from "../types/device.js";

/**
 * Builds a fake `Cookie:` header containing an `SES_TOKEN` JWT with the
 * given payload — exists so `extractAccountEmail` can be tested against a
 * known `sub` claim without a real captured session cookie. The header and
 * signature segments aren't cryptographically valid, which is fine:
 * `extractAccountEmail` never verifies the signature, only decodes the
 * payload.
 *
 * @param payload the JWT payload to embed, e.g. `{ sub: "user@example.com" }`.
 * @returns a `Cookie:`-header-shaped string containing the fabricated
 *   `SES_TOKEN`.
 * @example
 * ```ts
 * fakeSesTokenCookie({ sub: "alex@example.com" });
 * // => "JSESSIONID=abc123; SES_TOKEN=eyJ...header...eyJ...payload....fakesignature"
 * ```
 */
function fakeSesTokenCookie(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `JSESSIONID=abc123; SES_TOKEN=${header}.${body}.fakesignature`;
}

test("extractAccountEmail returns the sub claim from a well-formed SES_TOKEN", () => {
  const cookie = fakeSesTokenCookie({
    user_id: 12345,
    id: 1,
    sub: "alex@example.com",
    iat: 1700000000,
    exp: 1700086400,
  });

  assert.equal(extractAccountEmail(cookie), "alex@example.com");
});

test("extractAccountEmail returns null when SES_TOKEN is missing from the cookie", () => {
  assert.equal(extractAccountEmail("JSESSIONID=abc123"), null);
});

test("extractAccountEmail returns null when the sub claim isn't a string", () => {
  const cookie = fakeSesTokenCookie({ sub: 12345 });

  assert.equal(extractAccountEmail(cookie), null);
});

test("extractAccountEmail returns null for a malformed SES_TOKEN (not a JWT)", () => {
  assert.equal(extractAccountEmail("JSESSIONID=abc123; SES_TOKEN=not-a-jwt"), null);
});

const idriveCookie = process.env.IDRIVE_COOKIE;

/**
 * Wires up a real `McpServer` with the device tools registered, connected to
 * a real `Client` over an in-memory transport pair — exists so the
 * integration test below exercises the actual MCP `tools/call` protocol
 * path rather than calling the registered handler function directly.
 *
 * @returns a connected MCP `Client` ready to call `list_devices`.
 */
async function connectTestClient(): Promise<Client> {
  const server = new McpServer({ name: "idrive-mcp-server-test", version: "0.0.0" });
  registerDeviceTools(server, new IdriveClient(idriveCookie as string));

  const client = new Client({ name: "idrive-mcp-server-test-client", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  return client;
}

if (!idriveCookie) {
  test("list_devices (skipped: IDRIVE_COOKIE not set)", { skip: true }, () => {});
} else {
  test("list_devices returns the account's real device list", async () => {
    const client = await connectTestClient();
    const result = await client.callTool({ name: "list_devices" });

    assert.notEqual(result.isError, true, `tool returned an error: ${JSON.stringify(result)}`);

    const structured = result.structuredContent as { devices: Device[] } | undefined;
    assert.ok(structured, "expected structuredContent to be present");
    assert.ok(Array.isArray(structured.devices), "expected devices to be an array");

    for (const device of structured.devices) {
      assert.equal(typeof device.device_id, "string");
      assert.equal(typeof device.nick_name, "string");
      assert.equal(typeof device.os, "string");
    }
  });
}
