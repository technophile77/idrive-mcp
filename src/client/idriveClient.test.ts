import { test } from "node:test";
import assert from "node:assert/strict";
import { parseGetNewServerResponse } from "./idriveClient.js";

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
