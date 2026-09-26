/** Serial uploads with a byte budget and terminal failure. No retry after failure. */
export class UploadQueue<T> {
  private tail = Promise.resolve();
  private failure?: Error;
  private bytes = 0;
  constructor(
    private readonly send: (value: T) => Promise<void>,
    private readonly limit = 4 * 1024 * 1024,
  ) {}
  get pendingBytes() {
    return this.bytes;
  }
  enqueue(value: T, bytes: number) {
    if (this.failure) return Promise.reject(this.failure);
    if (this.bytes + bytes > this.limit) {
      this.cancel(
        new Error("The connection cannot keep up with the microphone. Recording stopped."),
      );
      return Promise.reject(this.failure);
    }
    this.bytes += bytes;
    const task = this.tail
      .then(async () => {
        if (this.failure) throw this.failure;
        await this.send(value);
      })
      .catch((error: unknown) => {
        this.cancel(error instanceof Error ? error : new Error("Audio upload failed."));
        throw this.failure;
      })
      .finally(() => {
        this.bytes -= bytes;
      });
    this.tail = task.catch(() => {});
    return task;
  }
  cancel(error = new Error("Recording cancelled.")) {
    this.failure ??= error;
  }
  async drain() {
    await this.tail;
    if (this.failure) throw this.failure;
  }
}
