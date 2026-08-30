import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { EvsDownloadHttpError, IdriveClient, parseGetNewServerResponse } from "./idriveClient.js";

test("parseGetNewServerResponse splits a well-formed getnewserver response into its tokenLogin URL and EVS host", () => {
  const responseText =
    "\r\n\r\nhttps://evsweb5187.idrive.com/evs/tokenLogin?token=abc123&sid=def456&rm=null&content_type=img$evsweb5187.idrive.com";

  assert.deepEqual(parseGetNewServerResponse(responseText), {
    tokenLoginUrl:
      "https://evsweb5187.idrive.com/evs/tokenLogin?token=abc123&sid=def456&rm=null&content_type=img",
    evsHost: "evsweb5187.idrive.com",
  });
});

test("parseGetNewServerResponse tolerates surrounding whitespace around the URL and host", () => {
  const responseText = "  \r\n\r\n  https://otherhost.idrive.com/evs/tokenLogin?token=xyz$  otherhost.idrive.com  ";

  assert.deepEqual(parseGetNewServerResponse(responseText), {
    tokenLoginUrl: "https://otherhost.idrive.com/evs/tokenLogin?token=xyz",
    evsHost: "otherhost.idrive.com",
  });
});

test("parseGetNewServerResponse returns null when there is no $ separator", () => {
  assert.equal(parseGetNewServerResponse("\r\n\r\nhttps://evsweb5187.idrive.com/evs/tokenLogin?token=abc"), null);
});

test("parseGetNewServerResponse returns null when the URL half is empty", () => {
  assert.equal(parseGetNewServerResponse("$evsweb5187.idrive.com"), null);
});

test("parseGetNewServerResponse returns null when the host half is empty", () => {
  assert.equal(parseGetNewServerResponse("https://evsweb5187.idrive.com/evs/tokenLogin?token=abc$"), null);
});

test("parseGetNewServerResponse returns null for an empty response body", () => {
  assert.equal(parseGetNewServerResponse(""), null);
});

/**
 * Starts a local `node:http` server that plays the role of both
 * `www.idrive.com`'s `getnewserver` bootstrap step and the EVS satellite
 * host's `evs/tokenLogin`/`evs/downloadFile` endpoints, so
 * {@link IdriveClient.downloadEvsToFile}'s full bootstrap-then-download flow
 * (including its EVSID-invalidation retry) can be exercised end-to-end
 * against real HTTP traffic instead of a hand-mocked response object — per
 * this project's standing rule against tests that don't exercise genuine
 * behavior. Every `/evs/downloadFile` call responds with the same
 * `downloadFileBody`, written across many small chunks (mirrors
 * `src/tools/files.test.ts`'s `startChunkedBodyServer`) so the response is
 * genuinely streamed rather than pre-buffered.
 *
 * @param downloadFileBody the exact bytes `POST /evs/downloadFile` responds
 *   with on every call.
 * @returns the running server (call `.close()` when done) and the base URL
 *   it's listening on.
 */
async function startFakeEvsHandshakeAndDownloadServer(
  downloadFileBody: Buffer,
): Promise<{ server: ReturnType<typeof createServer>; url: string }> {
  const server = createServer((req, res) => {
    if (req.url?.startsWith("/idrive/home/getnewserver")) {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("\r\n\r\nhttp://evsweb-test.local/evs/tokenLogin?token=abc&sid=def$evsweb-test.local");
      return;
    }

    if (req.url?.startsWith("/evs/tokenLogin")) {
      res.writeHead(200, {
        "Content-Type": "image/jpeg",
        "Set-Cookie": "EVSID=test-evsid-value; SameSite=none; HttpOnly; Secure",
      });
      res.end();
      return;
    }

    if (req.url?.startsWith("/evs/downloadFile")) {
      res.writeHead(200, { "Content-Type": "text/plain;charset=UTF-8" });
      const chunkSize = 512;
      for (let offset = 0; offset < downloadFileBody.length; offset += chunkSize) {
        res.write(downloadFileBody.subarray(offset, offset + chunkSize));
      }
      res.end();
      return;
    }

    res.writeHead(404);
    res.end();
  });

  await new Promise<void>((resolve) => server.listen(0, () => resolve()));
  const { port } = server.address() as AddressInfo;
  return { server, url: `http://127.0.0.1:${port}` };
}

/**
 * Builds a `fetch` replacement that redirects every call's origin to
 * `baseUrl` while preserving the original path and query string — exists
 * because {@link IdriveClient} always targets `https://www.idrive.com` or
 * `https://<evsHost>` (never configurable), so a real request to those
 * fixed origins can't reach a local `127.0.0.1` test server without this
 * redirect. Only the origin is rewritten; the request otherwise goes out as
 * a genuine `fetch` call, so response streaming/parsing downstream is
 * exercised against real HTTP, not a fabricated `Response`.
 *
 * @param baseUrl the local test server's base URL, as returned by
 *   {@link startFakeEvsHandshakeAndDownloadServer}.
 * @returns a function with the same signature as the global `fetch`.
 */
function redirectFetchToLocalServer(baseUrl: string): typeof fetch {
  const realFetch = globalThis.fetch;
  return ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const originalUrl = typeof input === "string" || input instanceof URL ? new URL(input) : new URL(input.url);
    const redirected = new URL(`${originalUrl.pathname}${originalUrl.search}`, baseUrl);
    return realFetch(redirected, init);
  }) as typeof fetch;
}

test("downloadEvsToFile throws an EvsDownloadHttpError explaining the HTML fallback when both the first attempt and the retry return an HTML body", async (t) => {
  // Realistically sized (a few KB) rather than tiny, and shaped like the
  // confirmed iDrive marketing-homepage fallback body that evs/downloadFile
  // returns (with a 200 status) when the requested path doesn't actually
  // resolve to a real file for the device.
  const htmlBody = Buffer.from(
    `<!DOCTYPE html>\n<html><head><title>Online Backup for PC, Mac and iPhone | IDrive</title></head><body>${"<p>marketing content</p>".repeat(150)}</body></html>`,
    "utf8",
  );
  const { server, url } = await startFakeEvsHandshakeAndDownloadServer(htmlBody);
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "idrive-mcp-download-test-"));
  const destinationPath = path.join(tmpDir, "should-not-exist.bin");

  t.mock.method(globalThis, "fetch", redirectFetchToLocalServer(url));

  try {
    const client = new IdriveClient("EVS_SERVER=evsweb-test.local; SES_TOKEN=fake");

    await assert.rejects(
      () =>
        client.downloadEvsToFile(
          "/evs/downloadFile",
          { p: "/C/does-not-actually-exist.txt", json: "yes", device_id: "D01" },
          destinationPath,
        ),
      (error: unknown) => {
        assert.ok(error instanceof EvsDownloadHttpError, `expected an EvsDownloadHttpError, got ${String(error)}`);
        assert.match(error.message, /HTML/);
        assert.match(error.message, /browse_folder/);
        return true;
      },
    );
    await assert.rejects(() => stat(destinationPath), /ENOENT/);
  } finally {
    server.close();
    await rm(tmpDir, { recursive: true, force: true });
  }
});
