export type Waiter = {
  offset: number;
  resolve: (result: { timedOut: boolean }) => void;
  timer: number;
};

export class LongPollQueue {
  private waiters: Waiter[] = [];

  async waitForData(offset: number, timeoutMs: number): Promise<boolean> {
    return await new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w.timer !== timer);
        resolve(true);
      }, timeoutMs);

      const waiter: Waiter = {
        offset,
        timer: timer as unknown as number,
        resolve: (result) => resolve(result.timedOut),
      };

      this.waiters.push(waiter);
    });
  }

  notify(newTail: number): void {
    const ready = this.waiters.filter((w) => newTail > w.offset);
    this.waiters = this.waiters.filter((w) => newTail <= w.offset);

    for (const waiter of ready) {
      clearTimeout(waiter.timer);
      waiter.resolve({ timedOut: false });
    }
  }

  notifyAll(): void {
    const current = this.waiters;
    this.waiters = [];
    for (const waiter of current) {
      clearTimeout(waiter.timer);
      waiter.resolve({ timedOut: false });
    }
  }
}
