// Bundles test/*.test.ts with esbuild (TypeScript, no extra dependencies) and
// runs them with Node's built-in test runner.
import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { readdirSync, rmSync } from "node:fs";

const out = "dist/test";
rmSync(out, { recursive: true, force: true });
const entryPoints = readdirSync("test").filter((f) => f.endsWith(".test.ts")).map((f) => `test/${f}`);
await build({ entryPoints, outdir: out, bundle: true, platform: "node", format: "esm", target: "node20", outExtension: { ".js": ".mjs" }, sourcemap: "inline", logLevel: "warning" });
const files = readdirSync(out).filter((f) => f.endsWith(".mjs")).map((f) => `${out}/${f}`);
const run = spawnSync(process.execPath, ["--enable-source-maps", "--test", ...files], { stdio: "inherit" });
process.exit(run.status ?? 1);
