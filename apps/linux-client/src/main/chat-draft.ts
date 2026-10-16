// Only an explicit shortcut can consume a fresh, successfully copied take.
export class ChatDraft {
  private draft?: { text: string; at: number };
  private busy = false;
  constructor(
    private readonly now = Date.now,
    private readonly ttl = 120_000,
  ) {}
  get isPasting() {
    return this.busy;
  }
  clear() {
    this.draft = undefined;
  }
  ready(text: string) {
    this.draft = text.trim() ? { text, at: this.now() } : undefined;
  }
  async paste(readClipboard: () => string, deliver: (text: string) => Promise<void>) {
    if (this.busy) throw new Error("Chat paste is already running.");
    const draft = this.draft;
    if (!draft || this.now() - draft.at > this.ttl) {
      this.clear();
      throw new Error("No fresh transcript. Record again before pasting.");
    }
    if (readClipboard() !== draft.text) {
      this.clear();
      throw new Error("Clipboard changed since dictation. Record again before pasting.");
    }
    // Consume before delivery: uncertain failures must never produce a retry paste.
    this.clear();
    this.busy = true;
    try {
      await deliver(draft.text);
    } finally {
      this.busy = false;
    }
  }
}
