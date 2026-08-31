import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import {
  buildAlternateNormalization,
  buildAlternateNormalizationParams,
  EvsDownloadHttpError,
  IdriveClient,
  parseGetNewServerResponse,
} from "./idriveClient.js";

test("buildAlternateNormalization returns null for a pure-ASCII string (no decomposable characters)", () => {
  assert.equal(buildAlternateNormalization("plain-ascii-path.txt"), null);
});

test("buildAlternateNormalization returns null for an empty string", () => {
  assert.equal(buildAlternateNormalization(""), null);
});

test("buildAlternateNormalization returns the NFD form when given NFC input", () => {
  const nfc = "café".normalize("NFC");
  const nfd = "café".normalize("NFD");
  assert.notEqual(nfc, nfd, "test fixture assumption: café has distinct NFC/NFD code points");

  assert.equal(buildAlternateNormalization(nfc), nfd);
});

test("buildAlternateNormalization returns the NFC form when given NFD input (bidirectional, not hardcoded to NFD)", () => {
  const nfc = "café".normalize("NFC");
  const nfd = "café".normalize("NFD");

  assert.equal(buildAlternateNormalization(nfd), nfc);
});

test("buildAlternateNormalizationParams returns null when every current value of fieldName is already normalization-invariant", () => {
  const params = new URLSearchParams({ json: "yes", device_id: "D01" });
  params.append("p", "/C/plain/ascii/path.txt");
  params.append("p", "/C/another/ascii/path.txt");

  assert.equal(buildAlternateNormalizationParams(params, "p"), null);
});

test("buildAlternateNormalizationParams remaps a single accented value to its alternate normalization, leaving other fields untouched", () => {
  const nfc = "/C/café".normalize("NFC");
  const nfd = "/C/café".normalize("NFD");
  const params = new URLSearchParams({ json: "yes", device_id: "D01" });
  params.append("p", nfc);

  const result = buildAlternateNormalizationParams(params, "p");
  assert.notEqual(result, null);
  assert.equal(result?.get("json"), "yes");
  assert.equal(result?.get("device_id"), "D01");
  assert.deepEqual(result?.getAll("p"), [nfd]);
});

test("buildAlternateNormalizationParams remaps only the mis-normalized values in a mixed ASCII/accented batch, preserving field order", () => {
  const nfc = "/C/café".normalize("NFC");
  const nfd = "/C/café".normalize("NFD");
  const params = new URLSearchParams();
  params.append("p", "/C/plain-ascii.txt");
  params.append("p", nfc);
  params.append("json", "yes");

  const result = buildAlternateNormalizationParams(params, "p");
  assert.notEqual(result, null);
  assert.deepEqual(result?.getAll("p"), ["/C/plain-ascii.txt", nfd]);
  assert.equal(result?.get("json"), "yes");
});

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
  // Note: this test's path ("/C/does-not-actually-exist.txt") is pure ASCII,
  // so buildAlternateNormalizationParams(params, "p") returns null and the
  // normalization-retry branch added below never fires here — this test is
  // unaffected by that change, it only exercises the pre-existing
  // EVSID-invalidation retry exhausting itself.
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

/**
 * Reads a request's full `application/x-www-form-urlencoded` body and
 * resolves with its parsed `URLSearchParams`, so the fake servers below can
 * inspect the `p` field a real client request sent (rather than responding
 * identically regardless of the path, like
 * {@link startFakeEvsHandshakeAndDownloadServer} does) — needed to exercise
 * the normalization-retry behavior, which depends on which of two
 * differently-normalized `p` values a given request actually used.
 *
 * @param req the incoming `node:http` request whose body hasn't been read yet.
 * @returns the parsed form body.
 */
function readFormBody(req: IncomingMessage): Promise<URLSearchParams> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(new URLSearchParams(Buffer.concat(chunks).toString("utf8"))));
  });
}

/**
 * Starts a local `node:http` server that plays the same bootstrap role as
 * {@link startFakeEvsHandshakeAndDownloadServer}, but for a single
 * JSON-envelope `/evs/*` endpoint (e.g. `evs/getProperties`) whose response
 * depends on the request's `p` field — so a `requestEvs`/`requestEvsWithParams`
 * normalization retry (see {@link IdriveClient.requestEvsWithParams}) can be
 * exercised end-to-end against real HTTP traffic, mirroring the same
 * `p`-independent-response limitation {@link startFakeEvsHandshakeAndDownloadServer}
 * doesn't have to work around.
 *
 * @param evsPath the `/evs/*` endpoint path to serve, e.g. `/evs/getProperties`.
 * @param buildResponse builds the parsed JSON response body for a given
 *   request's `p` field value.
 * @returns the running server (call `.close()` when done) and the base URL
 *   it's listening on.
 */
async function startFakeEvsHandshakeAndJsonServer(
  evsPath: string,
  buildResponse: (p: string) => unknown,
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

    if (req.url?.startsWith(evsPath)) {
      readFormBody(req).then((params) => {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end(JSON.stringify(buildResponse(params.get("p") ?? "")));
      });
      return;
    }

    res.writeHead(404);
    res.end();
  });

  await new Promise<void>((resolve) => server.listen(0, () => resolve()));
  const { port } = server.address() as AddressInfo;
  return { server, url: `http://127.0.0.1:${port}` };
}

test("requestEvs transparently retries with the alternate normalization when the NFC form of an accented path returns INVALID PATH but the NFD form succeeds", async (t) => {
  const nfc = "/C/café".normalize("NFC");
  const nfd = "/C/café".normalize("NFD");

  const { server, url } = await startFakeEvsHandshakeAndJsonServer("/evs/getProperties", (p) => {
    if (p === nfd) {
      return { message: "SUCCESS", path: p, size: "1024", lmd: "2021/11/18 14:31:01", lmd_web: "1637245861" };
    }
    return { message: "ERROR", desc: "INVALID PATH" };
  });
  t.mock.method(globalThis, "fetch", redirectFetchToLocalServer(url));

  try {
    const client = new IdriveClient("EVS_SERVER=evsweb-test.local; SES_TOKEN=fake");
    const result = await client.requestEvs("/evs/getProperties", { p: nfc, json: "yes", device_id: "D01" });
    assert.deepEqual(result, {
      message: "SUCCESS",
      path: nfd,
      size: "1024",
      lmd: "2021/11/18 14:31:01",
      lmd_web: "1637245861",
    });
  } finally {
    server.close();
  }
});

test("requestEvs transparently retries with the alternate normalization in the reverse direction too (NFD fails, NFC succeeds) — proving the retry isn't hardcoded to one form", async (t) => {
  const nfc = "/C/café".normalize("NFC");
  const nfd = "/C/café".normalize("NFD");

  const { server, url } = await startFakeEvsHandshakeAndJsonServer("/evs/getProperties", (p) => {
    if (p === nfc) {
      return { message: "SUCCESS", path: p, size: "2048", lmd: "2021/11/18 14:31:01", lmd_web: "1637245861" };
    }
    return { message: "ERROR", desc: "INVALID PATH" };
  });
  t.mock.method(globalThis, "fetch", redirectFetchToLocalServer(url));

  try {
    const client = new IdriveClient("EVS_SERVER=evsweb-test.local; SES_TOKEN=fake");
    const result = await client.requestEvs("/evs/getProperties", { p: nfd, json: "yes", device_id: "D01" });
    assert.deepEqual(result, {
      message: "SUCCESS",
      path: nfc,
      size: "2048",
      lmd: "2021/11/18 14:31:01",
      lmd_web: "1637245861",
    });
  } finally {
    server.close();
  }
});

test("requestEvs does not attempt a normalization retry, and simply returns the INVALID PATH error, when the path is pure ASCII", async (t) => {
  const { server, url } = await startFakeEvsHandshakeAndJsonServer("/evs/getProperties", () => ({
    message: "ERROR",
    desc: "INVALID PATH",
  }));
  t.mock.method(globalThis, "fetch", redirectFetchToLocalServer(url));

  try {
    const client = new IdriveClient("EVS_SERVER=evsweb-test.local; SES_TOKEN=fake");
    const result = await client.requestEvs("/evs/getProperties", {
      p: "/C/does-not-exist.txt",
      json: "yes",
      device_id: "D01",
    });
    assert.deepEqual(result, { message: "ERROR", desc: "INVALID PATH" });
  } finally {
    server.close();
  }
});

/**
 * Starts a local `node:http` server like {@link startFakeEvsHandshakeAndDownloadServer},
 * but whose `/evs/downloadFile` response depends on the request's `p`
 * field — one form gets the HTML marketing-page fallback, the other gets
 * real file bytes — so {@link IdriveClient.downloadEvsToFile}'s
 * normalization retry (which fires when the post-EVSID-retry attempt looks
 * like an HTML document) can be exercised end-to-end.
 *
 * @param htmlPath the `p` value that should receive the HTML fallback body.
 * @param realPath the `p` value that should receive `realFileBody`.
 * @param realFileBody the real file bytes served for `realPath`, written
 *   across many small chunks so the response is genuinely streamed.
 * @returns the running server (call `.close()` when done) and the base URL
 *   it's listening on.
 */
async function startFakeEvsHandshakeAndPathSensitiveDownloadServer(
  htmlPath: string,
  realPath: string,
  realFileBody: Buffer,
): Promise<{ server: ReturnType<typeof createServer>; url: string }> {
  const htmlBody = Buffer.from(
    `<!DOCTYPE html>\n<html><head><title>Online Backup for PC, Mac and iPhone | IDrive</title></head><body>${"<p>marketing content</p>".repeat(150)}</body></html>`,
    "utf8",
  );

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
      readFormBody(req).then((params) => {
        const p = params.get("p") ?? "";
        const body = p === realPath ? realFileBody : htmlBody;
        res.writeHead(200, { "Content-Type": "text/plain;charset=UTF-8" });
        const chunkSize = 512;
        for (let offset = 0; offset < body.length; offset += chunkSize) {
          res.write(body.subarray(offset, offset + chunkSize));
        }
        res.end();
      });
      return;
    }

    res.writeHead(404);
    res.end();
  });

  await new Promise<void>((resolve) => server.listen(0, () => resolve()));
  const { port } = server.address() as AddressInfo;
  return { server, url: `http://127.0.0.1:${port}` };
}

test("downloadEvsToFile transparently retries with the alternate normalization and reports the pathUsed that actually resolved when the caller-supplied form gets the HTML fallback", async (t) => {
  const nfc = "/C/café.txt".normalize("NFC");
  const nfd = "/C/café.txt".normalize("NFD");
  const realFileBody = Buffer.from("real file content".repeat(50), "utf8");

  const { server, url } = await startFakeEvsHandshakeAndPathSensitiveDownloadServer(nfc, nfd, realFileBody);
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "idrive-mcp-download-normalization-test-"));
  const destinationPath = path.join(tmpDir, "café.txt");

  t.mock.method(globalThis, "fetch", redirectFetchToLocalServer(url));

  try {
    const client = new IdriveClient("EVS_SERVER=evsweb-test.local; SES_TOKEN=fake");
    const result = await client.downloadEvsToFile(
      "/evs/downloadFile",
      { p: nfc, json: "yes", device_id: "D01" },
      destinationPath,
    );

    assert.deepEqual(result, { bytesWritten: realFileBody.length, pathUsed: nfd });
    const written = await stat(destinationPath);
    assert.equal(written.size, realFileBody.length);
  } finally {
    server.close();
    await rm(tmpDir, { recursive: true, force: true });
  }
});
