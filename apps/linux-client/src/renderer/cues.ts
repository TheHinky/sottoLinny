// Short synthesized sound cues for each stage, so shortcut use works without
// looking at the window. Web Audio oscillators: no audio files, no CSP changes.
export type Cue = "start" | "stop" | "done" | "cancel" | "error";

// Frequencies (Hz) played in sequence; rising = start, falling = stop.
const notes: Record<Cue, number[]> = {
  start: [660, 880],
  stop: [880, 660],
  done: [1320],
  cancel: [520, 390],
  error: [330, 247, 330],
};
const noteSeconds = 0.07;
const volume = 0.06;

let context: AudioContext | undefined;

export function playCue(cue: Cue) {
  const audio = (context ??= new AudioContext());
  void audio.resume();
  const at = audio.currentTime + 0.01;
  notes[cue].forEach((frequency, index) => {
    const start = at + index * noteSeconds;
    const oscillator = new OscillatorNode(audio, { type: "sine", frequency });
    const gain = new GainNode(audio, { gain: 0 });
    gain.gain.setValueAtTime(0, start);
    // Short attack/release envelope avoids clicks.
    gain.gain.linearRampToValueAtTime(volume, start + 0.01);
    gain.gain.linearRampToValueAtTime(0, start + noteSeconds);
    oscillator.connect(gain).connect(audio.destination);
    oscillator.start(start);
    oscillator.stop(start + noteSeconds);
  });
}
