import type { Speaker } from "../shared/types";

export interface CaptureOptions {
  system: boolean;
  mic: boolean;
}

/** Captures call audio (system loopback) as "them" and the microphone as "me", as 16 kHz mono. */
export class Capture {
  private ctx: AudioContext | null = null;
  private streams: MediaStream[] = [];
  private levels = new Map<Speaker, number>();

  async start(opts: CaptureOptions, onChunk: (speaker: Speaker, samples: Float32Array) => void): Promise<void> {
    this.ctx = new AudioContext({ sampleRate: 16000 });
    await this.ctx.audioWorklet.addModule("pcm-worklet.js");
    // Worklets only run while connected to the output; route through a muted gain.
    const sink = this.ctx.createGain();
    sink.gain.value = 0;
    sink.connect(this.ctx.destination);

    const attach = (stream: MediaStream, speaker: Speaker) => {
      const node = new AudioWorkletNode(this.ctx!, "pcm-capture");
      node.port.onmessage = (e: MessageEvent<Float32Array>) => {
        this.levels.set(speaker, rms(e.data));
        onChunk(speaker, e.data);
      };
      this.ctx!.createMediaStreamSource(stream).connect(node);
      node.connect(sink);
      this.streams.push(stream);
    };

    try {
      if (opts.system) {
        // The main process answers this with the screen + "loopback" system audio.
        const display = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
        if (!display.getAudioTracks().length) throw new Error("No system audio track was provided.");
        // Keep the video track alive (stopping it can end loopback audio), just unused.
        display.getVideoTracks().forEach((t) => (t.enabled = false));
        attach(display, "them");
      }
      if (opts.mic) {
        const mic = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        });
        attach(mic, "me");
      }
    } catch (err) {
      await this.stop();
      throw err;
    }
  }

  /** Recent loudness per source, 0..1, for the level meters. */
  level(speaker: Speaker): number {
    return this.levels.get(speaker) ?? 0;
  }

  async stop(): Promise<void> {
    this.streams.forEach((s) => s.getTracks().forEach((t) => t.stop()));
    this.streams = [];
    this.levels.clear();
    await this.ctx?.close();
    this.ctx = null;
  }
}

function rms(samples: Float32Array): number {
  let sum = 0;
  for (const s of samples) sum += s * s;
  return Math.min(1, Math.sqrt(sum / samples.length) * 4);
}
