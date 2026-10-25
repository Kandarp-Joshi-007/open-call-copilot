import { build } from "esbuild";
import { cpSync, mkdirSync } from "node:fs";

const common = { bundle: true, sourcemap: true, logLevel: "info" };

mkdirSync("dist/renderer", { recursive: true });
for (const file of ["dashboard.html", "dashboard.css", "overlay.html", "overlay.css", "styles.css", "pcm-worklet.js"]) {
  cpSync(`src/renderer/${file}`, `dist/renderer/${file}`);
}

await Promise.all([
  // Main process is ESM so unpdf (ESM-only) can be bundled; native addon stays external.
  build({
    ...common,
    entryPoints: ["src/main/main.ts"],
    outfile: "dist/main.mjs",
    platform: "node",
    format: "esm",
    target: "node20",
    external: ["electron", "sherpa-onnx-node"],
    banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  }),
  // Sandboxed preload scripts must be CommonJS.
  build({
    ...common,
    entryPoints: ["src/preload/preload.ts"],
    outfile: "dist/preload.cjs",
    platform: "node",
    format: "cjs",
    external: ["electron"],
  }),
  ...["dashboard", "overlay"].map((page) =>
    build({
      ...common,
      entryPoints: [`src/renderer/${page}.ts`],
      outfile: `dist/renderer/${page}.js`,
      platform: "browser",
      format: "iife",
      target: "chrome120",
    }),
  ),
]);
