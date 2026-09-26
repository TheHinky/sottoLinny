class SottoCaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.keepOriginal = options.processorOptions?.keepOriginalAudio === true;
    this.stopped = false;
    this.frames = 0;
    this.outstandingBytes = 0;
    this.inference = [];
    this.original = [];
    this.position = 0;
    this.previous = 0;
    this.channels = 0;
    this.filter = this.createLowPassFilter(sampleRate, 16000);
    this.port.onmessage = (event) => {
      if (event.data?.type === "ack") {
        this.outstandingBytes = Math.max(0, this.outstandingBytes - event.data.bytes);
      }
      if (event.data === "flush") {
        this.stopped = true;
        this.flush();
        this.port.postMessage({ type: "flushed" });
      }
    };
  }

  process(inputs) {
    if (this.stopped) return true;
    const input = inputs[0];
    if (!input?.length || !input[0]?.length) return true;
    if (input.length > 8 || (this.channels && this.channels !== input.length)) {
      this.fail("Microphone channel format changed or is unsupported.");
      return true;
    }
    this.channels = input.length;
    const maximumFrames = Math.floor(
      Math.min(
        179 * sampleRate,
        this.keepOriginal ? 268435456 / (4 * this.channels) - sampleRate * 0.1 : Infinity,
      ),
    );
    const frames = Math.min(input[0].length, maximumFrames - this.frames);
    if (frames <= 0) return true;
    this.frames += frames;
    const mono = new Float32Array(frames);

    for (let frame = 0; frame < frames; frame++) {
      let mixed = 0;
      for (let channel = 0; channel < input.length; channel++) {
        const value = input[channel][frame];
        if (!Number.isFinite(value)) {
          this.fail("Microphone produced invalid PCM.");
          return true;
        }
        mixed += value / input.length;
        if (this.keepOriginal) this.original.push(value);
      }
      mono[frame] = this.filterSample(mixed);
    }

    const extended = new Float32Array(frames + 1);
    extended[0] = this.previous;
    extended.set(mono, 1);
    const ratio = sampleRate / 16000;
    while (this.position + 1 < extended.length) {
      const index = Math.floor(this.position);
      const fraction = this.position - index;
      const value = extended[index] * (1 - fraction) + extended[index + 1] * fraction;
      this.inference.push(value);
      this.position += ratio;
    }
    this.position -= frames;
    this.previous = mono[frames - 1];

    if (this.inference.length >= 8000) this.emit("inference", this.inference, 16000, 1);
    if (this.keepOriginal && this.original.length >= sampleRate * input.length * 0.1) {
      this.emit("original", this.original, sampleRate, input.length);
    }
    if (this.frames >= maximumFrames) {
      this.stopped = true;
      this.flush();
      this.port.postMessage({ type: "limit" });
    }
    return true;
  }

  flush() {
    this.emit("inference", this.inference, 16000, 1);
    if (this.keepOriginal)
      this.emit("original", this.original, sampleRate, Math.max(1, this.channels));
  }

  fail(message) {
    this.stopped = true;
    this.original.length = this.inference.length = 0;
    this.port.postMessage({ type: "error", message });
  }

  createLowPassFilter(sourceRate, targetRate) {
    const taps = 63;
    const cutoff = Math.min(0.45 * targetRate, 0.45 * sourceRate) / sourceRate;
    const coefficients = new Float64Array(taps);
    const middle = (taps - 1) / 2;
    let sum = 0;
    for (let index = 0; index < taps; index++) {
      const offset = index - middle;
      const sinc =
        offset === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * offset) / (Math.PI * offset);
      const window = 0.54 - 0.46 * Math.cos((2 * Math.PI * index) / (taps - 1));
      coefficients[index] = sinc * window;
      sum += coefficients[index];
    }
    for (let index = 0; index < taps; index++) coefficients[index] /= sum;
    return { coefficients, history: new Float32Array(taps), cursor: 0 };
  }

  filterSample(value) {
    const filter = this.filter;
    filter.history[filter.cursor] = value;
    let output = 0;
    let historyIndex = filter.cursor;
    for (let index = 0; index < filter.coefficients.length; index++) {
      output += filter.coefficients[index] * filter.history[historyIndex];
      historyIndex = (historyIndex - 1 + filter.history.length) % filter.history.length;
    }
    filter.cursor = (filter.cursor + 1) % filter.history.length;
    return output;
  }

  emit(kind, values, rate, channels) {
    if (!values.length) return;
    if (this.outstandingBytes + values.length * 4 > 4 * 1024 * 1024) {
      this.fail("Audio uploads fell behind. Recording stopped.");
      return;
    }
    const samples = Float32Array.from(values);
    this.outstandingBytes += samples.byteLength;
    values.length = 0;
    this.port.postMessage(
      { type: "chunk", kind, sampleRate: Math.round(rate), channels, samples: samples.buffer },
      [samples.buffer],
    );
  }
}

registerProcessor("sotto-capture", SottoCaptureProcessor);
