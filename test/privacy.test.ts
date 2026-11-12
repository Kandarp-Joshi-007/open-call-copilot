import assert from "node:assert/strict";
import { test } from "node:test";
import { captureProtection } from "../src/main/privacy";

test("capture protection by Windows version", () => {
  assert.equal(captureProtection("win32", "10.0.26100"), "hidden"); // Windows 11
  assert.equal(captureProtection("win32", "10.0.19041"), "hidden"); // Windows 10 2004
  assert.equal(captureProtection("win32", "10.0.18363"), "blacked-out"); // Windows 10 1909
  assert.equal(captureProtection("win32", "6.1.7601"), "blacked-out"); // Windows 7
  assert.equal(captureProtection("linux", "6.8.0"), "unsupported");
});
