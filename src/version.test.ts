import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getServerVersion } from "./version.js";

/**
 * The real `package.json` `version` field, read independently of
 * `getServerVersion()`'s own package.json-reading logic — used below as the
 * ground truth to compare against, so these assertions actually exercise
 * `getServerVersion()`'s real behavior instead of checking its output
 * against itself.
 */
const expectedPackageVersion = (JSON.parse(readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8")) as {
  version: string;
}).version;

test("getServerVersion reports the real package.json version", () => {
  const { packageVersion } = getServerVersion();
  assert.equal(packageVersion, expectedPackageVersion);
});

test("getServerVersion's gitDescriptor is either null or a non-empty descriptor string", () => {
  const { gitDescriptor } = getServerVersion();
  if (gitDescriptor !== null) {
    assert.equal(typeof gitDescriptor, "string");
    assert.ok(gitDescriptor.length > 0, "expected a non-empty git descriptor");
  }
});

test("getServerVersion's displayVersion always starts with the package version", () => {
  const { packageVersion, displayVersion } = getServerVersion();
  assert.ok(
    displayVersion.startsWith(packageVersion),
    `expected displayVersion (${displayVersion}) to start with packageVersion (${packageVersion})`,
  );
});

test("getServerVersion's displayVersion combines both fields exactly when git info is available, or is just the package version otherwise", () => {
  const { packageVersion, gitDescriptor, displayVersion } = getServerVersion();
  const expectedDisplayVersion = gitDescriptor === null ? packageVersion : `${packageVersion} (git ${gitDescriptor})`;
  assert.equal(displayVersion, expectedDisplayVersion);
});

test("getServerVersion returns the same computed object on repeated calls (computed once at module load)", () => {
  assert.equal(getServerVersion(), getServerVersion());
});

test("getServerVersion never throws, even when called repeatedly in a loop", () => {
  for (let i = 0; i < 10; i++) {
    assert.doesNotThrow(() => getServerVersion());
  }
});
