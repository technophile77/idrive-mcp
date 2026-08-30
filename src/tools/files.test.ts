import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { IdriveClient, peekAndStreamResponseToFile } from "../client/idriveClient.js";
import { extractEvsServerHost } from "../client/session.js";
import { buildRepeatedPathParams, registerFileTools } from "./files.js";

const cookie = process.env.IDRIVE_COOKIE;
const deviceId = process.env.IDRIVE_TEST_DEVICE_ID;
/** EVS-format path (e.g. `/C`) to `browse_folder`/`get_thumbnail`-test against — see `docs/api-map.md`'s note that this endpoint has never been observed handling a bare root path. */
const evsPath = process.env.IDRIVE_TEST_EVS_PATH;
/**
 * Explicit opt-in gate for the `create_folder`/`delete_file`/`restore_from_trash`
 * integration test below, separate from `IDRIVE_COOKIE`/`IDRIVE_TEST_DEVICE_ID`/
 * `IDRIVE_TEST_EVS_PATH`. Those three alone are enough to run every other
 * (read-only) integration test in this file, so a developer who's only set
 * them up for read-only testing must NOT have `npm test` silently mutate
 * their real account — this must be set to exactly `"1"` as well, on top of
 * the other three, before the mutating test runs. See `README.md`'s
 * "Testing" section.
 */
const allowMutations = process.env.IDRIVE_TEST_ALLOW_MUTATIONS === "1";

test("extractEvsServerHost returns the EVS_SERVER value from a cookie header that has one", () => {
  const cookieHeader = "JSESSIONID=abc123; EVS_SERVER=evsweb5187.idrive.com; SES_TOKEN=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyQGV4YW1wbGUuY29tIn0.sig";
  assert.equal(extractEvsServerHost(cookieHeader), "evsweb5187.idrive.com");
});

test("extractEvsServerHost returns null when EVS_SERVER is absent from the cookie", () => {
  assert.equal(extractEvsServerHost("JSESSIONID=abc123; SES_TOKEN=abc.def.ghi"), null);
});

test("extractEvsServerHost returns null for an empty cookie string", () => {
  assert.equal(extractEvsServerHost(""), null);
});

test("buildRepeatedPathParams sets each extra field once and appends one p per path, in order", () => {
  const params = buildRepeatedPathParams(["/C/a", "/C/b", "/C/c"], { json: "yes", device_id: "D01" });

  assert.deepEqual(params.getAll("json"), ["yes"]);
  assert.deepEqual(params.getAll("device_id"), ["D01"]);
  assert.deepEqual(params.getAll("p"), ["/C/a", "/C/b", "/C/c"]);
});

test("buildRepeatedPathParams with a single path is equivalent to a plain URLSearchParams for that path", () => {
  const params = buildRepeatedPathParams(["/C/only"], { trash: "yes" });
  assert.equal(params.toString(), new URLSearchParams({ trash: "yes", p: "/C/only" }).toString());
});

test("buildRepeatedPathParams: for any random set of paths and extra fields, every path round-trips through getAll(\"p\") in order and no extra field leaks into it", () => {
  for (let i = 0; i < 50; i++) {
    const pathCount = 1 + Math.floor(Math.random() * 6);
    const paths = Array.from({ length: pathCount }, (_, index) => `/C/random-${i}-${index}-${Math.random().toString(36).slice(2)}`);
    const extraFields: Record<string, string> = {
      json: "yes",
      device_id: `D${Math.floor(Math.random() * 1_000_000)}`,
    };

    const params = buildRepeatedPathParams(paths, extraFields);

    assert.deepEqual(params.getAll("p"), paths);
    for (const [key, value] of Object.entries(extraFields)) {
      assert.deepEqual(params.getAll(key), [value]);
    }
  }
});

/**
 * Wires up a real `McpServer` with the file tools registered, connected to a
 * real `Client` over an in-memory transport pair — exists so the test below
 * exercises the actual MCP `tools/call` protocol path rather than calling the
 * registered handler function directly.
 *
 * @returns a connected MCP `Client` ready to call `list_files`.
 */
async function connectTestClient(): Promise<Client> {
  const server = new McpServer({ name: "idrive-mcp-server-test", version: "0.0.0" });
  registerFileTools(server, new IdriveClient(cookie as string));

  const client = new Client({ name: "idrive-mcp-server-test-client", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  return client;
}

/**
 * Extracts and JSON-parses the text of a successful tool call's first
 * content item — exists so the test doesn't repeat the same content-shape
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

/**
 * Starts a local `node:http` server that responds to every request by
 * writing `body` in many small chunks via repeated `res.write()` calls,
 * rather than one buffered write — so a response consuming it (like
 * {@link peekAndStreamResponseToFile}) genuinely has to read the stream
 * across many chunks, not just unwrap one pre-assembled buffer. Exists so
 * `peekAndStreamResponseToFile`'s streaming tests below exercise a real
 * `fetch()` against real chunked HTTP delivery, per this project's standing
 * rule against tests that don't exercise genuine behavior — not a
 * hand-mocked `Response`.
 *
 * @param body the exact bytes the server responds with on every request.
 * @param chunkSize how many bytes to write per `res.write()` call.
 * @returns the running server (call `.close()` when done) and the base URL
 *   it's listening on.
 */
async function startChunkedBodyServer(
  body: Buffer,
  chunkSize: number,
): Promise<{ server: ReturnType<typeof createServer>; url: string }> {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/octet-stream" });
    for (let offset = 0; offset < body.length; offset += chunkSize) {
      res.write(body.subarray(offset, offset + chunkSize));
    }
    res.end();
  });

  await new Promise<void>((resolve) => server.listen(0, () => resolve()));
  const { port } = server.address() as AddressInfo;
  return { server, url: `http://127.0.0.1:${port}/` };
}

test("peekAndStreamResponseToFile streams a large multi-chunk response to disk byte-for-byte", async () => {
  const body = randomBytes(20 * 1024 * 1024); // 20 MB, forces many chunked reads at a 4 KB write size below.
  const { server, url } = await startChunkedBodyServer(body, 4096);
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "idrive-mcp-stream-test-"));
  const destinationPath = path.join(tmpDir, "downloaded.bin");

  try {
    const response = await fetch(url);
    const result = await peekAndStreamResponseToFile(response, destinationPath);

    assert.deepEqual(result, { kind: "downloaded", bytesWritten: body.length });
    const written = await readFile(destinationPath);
    assert.ok(written.equals(body), "downloaded file content did not match the sent bytes exactly");
  } finally {
    server.close();
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("peekAndStreamResponseToFile reports the invalid-EVSID shape and writes no file for a small matching body", async () => {
  const body = Buffer.from(JSON.stringify({ message: "ERROR", desc: "INVALID PARAMETERS" }), "utf8");
  const { server, url } = await startChunkedBodyServer(body, 32);
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "idrive-mcp-stream-test-"));
  const destinationPath = path.join(tmpDir, "should-not-exist.bin");

  try {
    const response = await fetch(url);
    const result = await peekAndStreamResponseToFile(response, destinationPath);

    assert.deepEqual(result, { kind: "invalid-evsid" });
    await assert.rejects(() => stat(destinationPath), /ENOENT/);
  } finally {
    server.close();
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("peekAndStreamResponseToFile treats a small, differently-shaped JSON body as real downloaded content", async () => {
  const body = Buffer.from(JSON.stringify({ message: "SUCCESS", size: "123", lmd: "1700000000" }), "utf8");
  const { server, url } = await startChunkedBodyServer(body, 16);
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "idrive-mcp-stream-test-"));
  const destinationPath = path.join(tmpDir, "downloaded.json");

  try {
    const response = await fetch(url);
    const result = await peekAndStreamResponseToFile(response, destinationPath);

    assert.deepEqual(result, { kind: "downloaded", bytesWritten: body.length });
    const written = await readFile(destinationPath);
    assert.ok(written.equals(body), "downloaded file content did not match the sent bytes exactly");
  } finally {
    server.close();
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("peekAndStreamResponseToFile reports the unexpected-html shape and writes no file for a marketing-homepage-sized HTML body", async () => {
  // Realistically sized (a few KB) rather than tiny, and far larger than
  // INVALID_EVSID_PEEK_BYTES (256) — mirrors the confirmed ~34KB iDrive
  // marketing homepage that evs/downloadFile falls back to serving when the
  // requested path doesn't resolve to a real file for the device.
  const filler = "<!-- padding to make this a realistically sized page --><p>Online Backup for PC, Mac and iPhone</p>\n".repeat(60);
  const body = Buffer.from(
    `<!DOCTYPE html>\n<html><head><title>Online Backup for PC, Mac and iPhone | IDrive</title></head><body>${filler}</body></html>`,
    "utf8",
  );
  const { server, url } = await startChunkedBodyServer(body, 512);
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "idrive-mcp-stream-test-"));
  const destinationPath = path.join(tmpDir, "should-not-exist.bin");

  try {
    const response = await fetch(url);
    const result = await peekAndStreamResponseToFile(response, destinationPath);

    assert.deepEqual(result, { kind: "unexpected-html" });
    await assert.rejects(() => stat(destinationPath), /ENOENT/);
  } finally {
    server.close();
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("peekAndStreamResponseToFile treats an HTML-looking body preceded by whitespace as unexpected-html too", async () => {
  const body = Buffer.from(`   \n\t<HTML><body>${"x".repeat(4000)}</body></html>`, "utf8");
  const { server, url } = await startChunkedBodyServer(body, 128);
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "idrive-mcp-stream-test-"));
  const destinationPath = path.join(tmpDir, "should-not-exist.bin");

  try {
    const response = await fetch(url);
    const result = await peekAndStreamResponseToFile(response, destinationPath);

    assert.deepEqual(result, { kind: "unexpected-html" });
    await assert.rejects(() => stat(destinationPath), /ENOENT/);
  } finally {
    server.close();
    await rm(tmpDir, { recursive: true, force: true });
  }
});

if (!cookie) {
  test("list_files (skipped: IDRIVE_COOKIE not set)", { skip: true }, () => {});
} else if (!deviceId) {
  test("list_files (skipped: IDRIVE_TEST_DEVICE_ID not set)", { skip: true }, () => {});
} else {
  test("list_files lists the root of a real device's backed-up file tree", async () => {
    const client = await connectTestClient();
    const result = await client.callTool({
      name: "list_files",
      arguments: { deviceId },
    });

    assert.notEqual(result.isError, true, `tool returned an error: ${JSON.stringify(result)}`);
    const listing = parseFirstTextContent(result as { content?: unknown }) as {
      path: string;
      contents: unknown[];
    };

    assert.equal(typeof listing.path, "string");
    assert.ok(Array.isArray(listing.contents), "expected contents to be an array");

    for (const entry of listing.contents as Record<string, unknown>[]) {
      assert.equal(typeof entry.is_dir, "boolean");
      assert.equal(typeof entry.name, "string");
      assert.equal(typeof entry.size, "string");
      assert.equal(typeof entry.lmd, "string");
      assert.equal(typeof entry.thumb_exists, "boolean");
    }
  });
}

if (!cookie) {
  test("browse_folder (skipped: IDRIVE_COOKIE not set)", { skip: true }, () => {});
} else if (!deviceId) {
  test("browse_folder (skipped: IDRIVE_TEST_DEVICE_ID not set)", { skip: true }, () => {});
} else if (!evsPath) {
  test("browse_folder (skipped: IDRIVE_TEST_EVS_PATH not set)", { skip: true }, () => {});
} else {
  test("browse_folder lists a real device's backed-up folder via the EVS endpoint", async () => {
    const client = await connectTestClient();
    const result = await client.callTool({
      name: "browse_folder",
      arguments: { deviceId, path: evsPath },
    });

    assert.notEqual(result.isError, true, `tool returned an error: ${JSON.stringify(result)}`);
    const listing = parseFirstTextContent(result as { content?: unknown }) as {
      path: string;
      contents: unknown[];
    };

    assert.equal(typeof listing.path, "string");
    assert.ok(Array.isArray(listing.contents), "expected contents to be an array");

    for (const entry of listing.contents as Record<string, unknown>[]) {
      assert.equal(typeof entry.is_dir, "boolean");
      assert.equal(typeof entry.name, "string");
      assert.equal(typeof entry.size, "string");
      assert.equal(typeof entry.lmd, "string");
      assert.equal(typeof entry.lmd_web, "string");
      assert.equal(typeof entry.thumb_exists, "boolean");
    }
  });

  test("get_thumbnail fetches a real thumbnail image for a backed-up file via the EVS endpoint", async (t) => {
    const client = await connectTestClient();

    const browseResult = await client.callTool({
      name: "browse_folder",
      arguments: { deviceId, path: evsPath },
    });
    assert.notEqual(browseResult.isError, true, `browse_folder returned an error: ${JSON.stringify(browseResult)}`);
    const listing = parseFirstTextContent(browseResult as { content?: unknown }) as {
      path: string;
      contents: Record<string, unknown>[];
    };

    const thumbnailableFile = listing.contents.find(
      (entry) => entry.is_dir === false && entry.thumb_exists === true,
    );
    if (!thumbnailableFile) {
      t.skip(`no file with thumb_exists=true found under IDRIVE_TEST_EVS_PATH (${evsPath}) to test against`);
      return;
    }

    const filePath = `${evsPath}/${thumbnailableFile.name as string}`;
    const result = await client.callTool({
      name: "get_thumbnail",
      arguments: { deviceId, path: filePath, timestamp: thumbnailableFile.lmd_web as string },
    });

    assert.notEqual(result.isError, true, `tool returned an error: ${JSON.stringify(result)}`);
    const content = result.content as Array<{ type: string; data: string; mimeType: string }>;
    assert.ok(Array.isArray(content) && content.length > 0, "expected at least one content item");
    assert.equal(content[0].type, "image");
    assert.equal(typeof content[0].data, "string");
    assert.ok(content[0].data.length > 0, "expected non-empty base64 image data");
    assert.equal(typeof content[0].mimeType, "string");
  });

  /**
   * Finds a real, non-directory file under `IDRIVE_TEST_EVS_PATH` via
   * `browse_folder`, so the `download_file`/`get_file_properties`/
   * `get_file_versions` tests below have a real file `path` to exercise
   * without requiring a separate dedicated env var — mirrors the
   * `get_thumbnail` test's own file-discovery pattern above.
   *
   * @param client a connected MCP client with the file tools registered.
   * @returns the discovered file's full EVS path.
   */
  async function findRealFilePath(client: Client): Promise<string | null> {
    const browseResult = await client.callTool({
      name: "browse_folder",
      arguments: { deviceId, path: evsPath },
    });
    assert.notEqual(browseResult.isError, true, `browse_folder returned an error: ${JSON.stringify(browseResult)}`);
    const listing = parseFirstTextContent(browseResult as { content?: unknown }) as {
      path: string;
      contents: Record<string, unknown>[];
    };

    const file = listing.contents.find((entry) => entry.is_dir === false);
    return file ? `${evsPath}/${file.name as string}` : null;
  }

  test("download_file downloads a real backed-up file's raw content to a local destination file via the EVS endpoint", async (t) => {
    const client = await connectTestClient();
    const filePath = await findRealFilePath(client);
    if (!filePath) {
      t.skip(`no file found under IDRIVE_TEST_EVS_PATH (${evsPath}) to test against`);
      return;
    }

    // findRealFilePath picks whatever file happens to sort first under IDRIVE_TEST_EVS_PATH — that's
    // very likely a small file, so this test exercises the tool end-to-end but doesn't by itself prove
    // the large-file fix (base64-inlining a whole file used to blow past the MCP stdio transport's
    // message size cap above ~7.4 MB). The dedicated peek-then-stream unit test below, against a real
    // ~20 MB multi-chunk HTTP response, is what actually proves that.
    const destinationPath = path.join(
      os.tmpdir(),
      `idrive-mcp-download-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );

    try {
      const result = await client.callTool({
        name: "download_file",
        arguments: { deviceId, path: filePath, destinationPath },
      });

      assert.notEqual(result.isError, true, `tool returned an error: ${JSON.stringify(result)}`);
      const downloaded = parseFirstTextContent(result as { content?: unknown }) as {
        path: string;
        bytesWritten: number;
      };
      assert.equal(downloaded.path, destinationPath);
      assert.ok(downloaded.bytesWritten > 0, "expected a non-zero bytesWritten");

      const fileStat = await stat(destinationPath);
      assert.equal(fileStat.size, downloaded.bytesWritten);
    } finally {
      await rm(destinationPath, { force: true });
    }
  });

  test("get_file_properties fetches real metadata for a backed-up file via the EVS endpoint", async (t) => {
    const client = await connectTestClient();
    const filePath = await findRealFilePath(client);
    if (!filePath) {
      t.skip(`no file found under IDRIVE_TEST_EVS_PATH (${evsPath}) to test against`);
      return;
    }

    const result = await client.callTool({
      name: "get_file_properties",
      arguments: { deviceId, path: filePath },
    });

    assert.notEqual(result.isError, true, `tool returned an error: ${JSON.stringify(result)}`);
    const properties = parseFirstTextContent(result as { content?: unknown }) as Record<string, unknown>;
    assert.equal(properties.message, "SUCCESS");
    assert.equal(typeof properties.path, "string");
    assert.equal(typeof properties.size, "string");
    assert.equal(typeof properties.lmd, "string");
    assert.equal(typeof properties.lmd_web, "string");
  });

  test("get_file_versions reports a real backed-up file's version history via the EVS endpoint", async (t) => {
    const client = await connectTestClient();
    const filePath = await findRealFilePath(client);
    if (!filePath) {
      t.skip(`no file found under IDRIVE_TEST_EVS_PATH (${evsPath}) to test against`);
      return;
    }

    const result = await client.callTool({
      name: "get_file_versions",
      arguments: { deviceId, path: filePath },
    });

    assert.notEqual(result.isError, true, `tool returned an error: ${JSON.stringify(result)}`);
    const versions = parseFirstTextContent(result as { content?: unknown }) as Record<string, unknown>;
    // Only the "no version history" shape is confirmed (see docs/api-map.md) — assert that shape
    // when it applies, otherwise just confirm the call succeeded and produced JSON for manual review.
    if (versions.hasVersions === false) {
      assert.equal(typeof versions.path, "string");
    } else {
      console.log("get_file_versions success-case response:", JSON.stringify(versions));
    }
  });
}

/**
 * `create_folder`/`delete_file`/`restore_from_trash` mutate real account
 * data (see each tool's own DocBlock), so this test is gated behind an
 * explicit extra opt-in (`IDRIVE_TEST_ALLOW_MUTATIONS=1`) on top of the
 * read-only credentials (`IDRIVE_COOKIE`/`IDRIVE_TEST_DEVICE_ID`/
 * `IDRIVE_TEST_EVS_PATH`) the other tests above already require — a
 * developer with a valid cookie set up purely for read-only testing must
 * not have `npm test` silently create/delete/restore real folders. It
 * creates a uniquely-named throwaway folder under `IDRIVE_TEST_EVS_PATH`
 * (so repeat runs never collide), exercises all three tools against it, and
 * — via `try`/`finally`, so this runs even if an assertion above it fails —
 * cleans up by moving that folder to trash before the test ends.
 */
if (!cookie) {
  test("create_folder / delete_file / restore_from_trash (skipped: IDRIVE_COOKIE not set)", { skip: true }, () => {});
} else if (!deviceId) {
  test("create_folder / delete_file / restore_from_trash (skipped: IDRIVE_TEST_DEVICE_ID not set)", { skip: true }, () => {});
} else if (!evsPath) {
  test("create_folder / delete_file / restore_from_trash (skipped: IDRIVE_TEST_EVS_PATH not set)", { skip: true }, () => {});
} else if (!allowMutations) {
  test(
    "create_folder / delete_file / restore_from_trash (skipped: IDRIVE_TEST_ALLOW_MUTATIONS not set to \"1\" — this test mutates real account data, see its own DocBlock)",
    { skip: true },
    () => {},
  );
} else {
  test("create_folder / delete_file / restore_from_trash mutate and clean up a real throwaway test folder", async () => {
    const client = await connectTestClient();
    const folderName = `mcp_test_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const folderPath = `${evsPath}/${folderName}`;

    const createResult = await client.callTool({
      name: "create_folder",
      arguments: { deviceId, parentPath: evsPath, folderName },
    });
    assert.notEqual(createResult.isError, true, `create_folder returned an error: ${JSON.stringify(createResult)}`);
    const created = parseFirstTextContent(createResult as { content?: unknown }) as { message: string };
    assert.equal(created.message, "SUCCESS");

    try {
      const deleteResult = await client.callTool({
        name: "delete_file",
        arguments: { deviceId, paths: [folderPath], permanent: false },
      });
      assert.notEqual(deleteResult.isError, true, `delete_file returned an error: ${JSON.stringify(deleteResult)}`);
      const deleted = parseFirstTextContent(deleteResult as { content?: unknown }) as {
        contents: Array<{ path: string; result: string }>;
      };
      assert.equal(deleted.contents.length, 1);
      assert.equal(deleted.contents[0].path, folderPath);
      assert.equal(deleted.contents[0].result, "SUCCESS");

      const restoreResult = await client.callTool({
        name: "restore_from_trash",
        arguments: { deviceId, paths: [folderPath] },
      });
      assert.notEqual(
        restoreResult.isError,
        true,
        `restore_from_trash returned an error: ${JSON.stringify(restoreResult)}`,
      );
      const restored = parseFirstTextContent(restoreResult as { content?: unknown }) as {
        contents: Array<{ path: string; result: string }>;
      };
      assert.equal(restored.contents.length, 1);
      assert.equal(restored.contents[0].path, folderPath);
      assert.equal(restored.contents[0].result, "SUCCESS");
    } finally {
      // Final cleanup: leave no new folder behind in the normal listing, regardless of whether the
      // assertions above passed — move it to trash one last time (never permanent: true here, since
      // that behavior is unverified — see delete_file's own DocBlock).
      const cleanupResult = await client.callTool({
        name: "delete_file",
        arguments: { deviceId, paths: [folderPath], permanent: false },
      });
      assert.notEqual(
        cleanupResult.isError,
        true,
        `cleanup delete_file returned an error: ${JSON.stringify(cleanupResult)} — the test folder ` +
          `${folderPath} may still exist on device ${deviceId} and need manual removal.`,
      );
    }
  });
}
