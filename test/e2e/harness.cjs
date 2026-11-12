// Entry point for the end-to-end test on systems without an OS keystore
// (Linux containers, CI). The app needs one at startup; Windows always has
// DPAPI, so on Windows the test starts the app directly instead of this file.
// It stands in for the keystore, then starts the real, unmodified app build.
const { safeStorage } = require("electron");
const { pathToFileURL } = require("node:url");

safeStorage.isEncryptionAvailable = () => true;
safeStorage.encryptString = (s) => Buffer.from(s, "utf8");
safeStorage.decryptString = (b) => b.toString("utf8");
import(pathToFileURL(process.env.MYNAH_MAIN).href);
