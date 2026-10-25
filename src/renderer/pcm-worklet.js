// Runs on the audio thread. The AudioContext is created at 16 kHz, so the
// browser has already resampled; this downmixes to mono and posts ~100 ms chunks.
const CHUNK = 1600;

class PcmCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(CHUNK);
    this.n = 0;
  }

  process(inputs) {
    const channels = inputs[0];
    if (!channels || channels.length === 0) return true;
    const frames = channels[0].length;
    for (let i = 0; i < frames; i++) {
      let sum = 0;
      for (let c = 0; c < channels.length; c++) sum += channels[c][i];
      this.buf[this.n++] = sum / channels.length;
      if (this.n === CHUNK) {
        this.port.postMessage(this.buf, [this.buf.buffer]);
        this.buf = new Float32Array(CHUNK);
        this.n = 0;
      }
    }
    return true;
  }
}

registerProcessor("pcm-capture", PcmCapture);
