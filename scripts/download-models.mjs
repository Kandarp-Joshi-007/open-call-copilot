// Downloads the local speech models into ./models:
//   - NVIDIA Parakeet TDT 0.6B v3 (int8, converted by sherpa-onnx), CC-BY-4.0, ~490 MB
//   - Silero VAD, ~0.6 MB
// Uses curl and tar, which ship with Windows 10/11.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";

const RELEASE = "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models";
const PARAKEET = "sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8";
const dir = path.resolve("models");
mkdirSync(dir, { recursive: true });

function run(cmd, args) {
  const r = spawnSync(cmd, args, { stdio: "inherit", cwd: dir });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed`);
}

if (!existsSync(path.join(dir, "silero_vad.onnx"))) {
  console.log("Downloading Silero VAD...");
  run("curl", ["-L", "--fail", "-o", "silero_vad.onnx", `${RELEASE}/silero_vad.onnx`]);
}

if (!existsSync(path.join(dir, PARAKEET, "encoder.int8.onnx"))) {
  const archive = `${PARAKEET}.tar.bz2`;
  console.log("Downloading Parakeet TDT 0.6B v3 (about 490 MB)...");
  run("curl", ["-L", "--fail", "-C", "-", "-o", archive, `${RELEASE}/${archive}`]);
  console.log("Extracting...");
  run("tar", ["-xjf", archive]);
  rmSync(path.join(dir, archive));
}

console.log(`Models ready in ${dir}`);
