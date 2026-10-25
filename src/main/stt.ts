import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import type { Speaker, SttStatus } from "../shared/types";

// Native addon (Node-API), loaded with require so esbuild leaves it alone.
const sherpa = createRequire(import.meta.url)("sherpa-onnx-node");

export const PARAKEET_DIR = "sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8";
const SAMPLE_RATE = 16000;

interface Channel {
  vad: any;
  pending: Float32Array;
}

/**
 * Local speech-to-text: Silero VAD cuts each audio source at pauses and
 * Parakeet TDT (non-streaming) decodes every finished segment.
 * Emits ("segment", speaker, text) and ("status", SttStatus).
 */
export class Transcriber extends EventEmitter {
  status: SttStatus = { state: "loading" };
  private recognizer: any = null;
  private channels = new Map<Speaker, Channel>();
  private vadModel = "";
  // One queue for both speakers keeps segments in the order they ended.
  private queue: Promise<void> = Promise.resolve();

  get ready(): boolean {
    return this.status.state === "ready";
  }

  async load(modelDir: string): Promise<void> {
    const dir = path.join(modelDir, PARAKEET_DIR);
    const files = ["encoder.int8.onnx", "decoder.int8.onnx", "joiner.int8.onnx", "tokens.txt"].map((f) => path.join(dir, f));
    this.vadModel = path.join(modelDir, "silero_vad.onnx");
    const missing = [...files, this.vadModel].filter((f) => !existsSync(f));
    if (missing.length) {
      this.setStatus({ state: "missing-models", message: `Run "npm run models". Missing: ${missing.map((f) => path.basename(f)).join(", ")}` });
      return;
    }

    this.setStatus({ state: "loading", message: "Loading Parakeet model..." });
    try {
      // createAsync keeps the 600 MB model load off the main thread.
      this.recognizer = await sherpa.OfflineRecognizer.createAsync({
        featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
        modelConfig: {
          transducer: { encoder: files[0], decoder: files[1], joiner: files[2] },
          tokens: files[3],
          modelType: "nemo_transducer",
          numThreads: 4,
          provider: "cpu",
          debug: 0,
        },
      });
      this.channels.clear();
      this.setStatus({ state: "ready" });
    } catch (err) {
      this.setStatus({ state: "error", message: (err as Error).message });
    }
  }

  /** samples: 16 kHz mono floats in [-1, 1], any chunk length. */
  feed(speaker: Speaker, samples: Float32Array): void {
    if (!this.ready) return;
    const ch = this.channel(speaker);
    const windowSize: number = ch.vad.config.sileroVad.windowSize;
    const merged = new Float32Array(ch.pending.length + samples.length);
    merged.set(ch.pending);
    merged.set(samples, ch.pending.length);

    let offset = 0;
    while (merged.length - offset >= windowSize) {
      ch.vad.acceptWaveform(merged.subarray(offset, offset + windowSize));
      offset += windowSize;
      this.drain(speaker, ch);
    }
    ch.pending = merged.slice(offset);
  }

  /** Decodes whatever speech is still buffered and resolves once all segments are emitted. */
  async flush(): Promise<void> {
    for (const [speaker, ch] of this.channels) {
      ch.vad.flush();
      this.drain(speaker, ch);
      ch.pending = new Float32Array(0);
    }
    await this.queue;
  }

  private channel(speaker: Speaker): Channel {
    let ch = this.channels.get(speaker);
    if (!ch) {
      const vad = new sherpa.Vad(
        {
          sileroVad: {
            model: this.vadModel,
            threshold: 0.5,
            minSpeechDuration: 0.25,
            // Short enough to answer quickly, long enough not to split a question mid-thought.
            minSilenceDuration: 0.6,
            maxSpeechDuration: 20,
            windowSize: 512,
          },
          sampleRate: SAMPLE_RATE,
          debug: false,
          numThreads: 1,
        },
        60,
      );
      ch = { vad, pending: new Float32Array(0) };
      this.channels.set(speaker, ch);
    }
    return ch;
  }

  private drain(speaker: Speaker, ch: Channel): void {
    while (!ch.vad.isEmpty()) {
      // false = copy the samples; Electron forbids N-API external buffers.
      const segment = ch.vad.front(false);
      ch.vad.pop();
      const samples: Float32Array = segment.samples;
      this.queue = this.queue.then(() => this.decode(speaker, samples));
    }
  }

  private async decode(speaker: Speaker, samples: Float32Array): Promise<void> {
    try {
      const stream = this.recognizer.createStream();
      stream.acceptWaveform({ sampleRate: SAMPLE_RATE, samples });
      await this.recognizer.decodeAsync(stream);
      const text: string = this.recognizer.getResult(stream).text.trim();
      if (text) this.emit("segment", speaker, text);
    } catch (err) {
      this.emit("error", err);
    }
  }

  private setStatus(status: SttStatus): void {
    this.status = status;
    this.emit("status", status);
  }
}
