import type { DurableStream } from "@durable-streams/client";

// Maximum messages to keep per stream to prevent unbounded memory growth
const MAX_MESSAGES_PER_STREAM = 1000;
// Delay before cleaning up a subscription with no listeners (allows quick navigation back)
const CLEANUP_DELAY_MS = 30000;

interface StreamSubscription {
  messages: Array<{ offset: string; data: string }>;
  listeners: Set<() => void>;
  abortController: AbortController | null;
  stream: DurableStream;
  cleanupTimer: ReturnType<typeof setTimeout> | null;
  // Pending messages to batch before notifying listeners
  pendingMessages: Array<{ offset: string; data: string }>;
  flushScheduled: boolean;
}

class StreamStore {
  private subscriptions = new Map<string, StreamSubscription>();
  private emptyMessages: Array<{ offset: string; data: string }> = [];

  subscribe(streamPath: string, stream: DurableStream, listener: () => void): () => void {
    // Get or create subscription
    let subscription = this.subscriptions.get(streamPath);

    if (!subscription) {
      subscription = {
        messages: [],
        listeners: new Set(),
        abortController: null,
        stream,
        cleanupTimer: null,
        pendingMessages: [],
        flushScheduled: false,
      };
      this.subscriptions.set(streamPath, subscription);
    }

    // Cancel any pending cleanup since we have a new listener
    if (subscription.cleanupTimer) {
      clearTimeout(subscription.cleanupTimer);
      subscription.cleanupTimer = null;
    }

    // Add listener
    subscription.listeners.add(listener);

    // Start following if not already
    if (!subscription.abortController) {
      const abortController = new AbortController();
      subscription.abortController = abortController;
      void this.followStream(streamPath, subscription);
    }

    // Return unsubscribe function
    return () => {
      const sub = this.subscriptions.get(streamPath);
      if (!sub) return;

      sub.listeners.delete(listener);

      // Schedule cleanup after delay if no listeners remain
      // This allows quick navigation back without losing data
      if (sub.listeners.size === 0 && !sub.cleanupTimer) {
        sub.cleanupTimer = setTimeout(() => {
          this.cleanupSubscription(streamPath);
        }, CLEANUP_DELAY_MS);
      }
    };
  }

  private cleanupSubscription(streamPath: string): void {
    const sub = this.subscriptions.get(streamPath);
    if (!sub) return;

    // Don't cleanup if listeners were added while waiting
    if (sub.listeners.size > 0) {
      sub.cleanupTimer = null;
      return;
    }

    // Abort the network connection
    if (sub.abortController) {
      sub.abortController.abort();
    }

    // Clear the cleanup timer reference
    if (sub.cleanupTimer) {
      clearTimeout(sub.cleanupTimer);
    }

    // Remove from subscriptions map to free memory
    this.subscriptions.delete(streamPath);
  }

  getMessages(streamPath: string): Array<{ offset: string; data: string }> {
    const subscription = this.subscriptions.get(streamPath);
    return subscription ? subscription.messages : this.emptyMessages;
  }

  private flushPendingMessages(subscription: StreamSubscription): void {
    const flushStart = performance.now();
    subscription.flushScheduled = false;

    if (subscription.pendingMessages.length === 0) return;

    const pendingCount = subscription.pendingMessages.length;
    console.log(`[stream-store] Flushing ${pendingCount} messages`);

    // Batch all pending messages into a single array update
    const newMessages = [...subscription.messages, ...subscription.pendingMessages];
    subscription.pendingMessages = [];

    // Apply size limit
    subscription.messages =
      newMessages.length > MAX_MESSAGES_PER_STREAM
        ? newMessages.slice(-MAX_MESSAGES_PER_STREAM)
        : newMessages;

    // Notify listeners once for the entire batch
    const listenerCount = subscription.listeners.size;
    subscription.listeners.forEach((listener) => listener());

    const flushEnd = performance.now();
    console.log(`[stream-store] Flush complete: ${pendingCount} msgs, ${listenerCount} listeners, ${(flushEnd - flushStart).toFixed(1)}ms`);
  }

  private async followStream(
    streamPath: string,
    subscription: StreamSubscription
  ): Promise<void> {
    try {
      // Start from last offset if we have messages, otherwise from beginning
      const startOffset =
        subscription.messages.length > 0
          ? subscription.messages[subscription.messages.length - 1].offset
          : "-1";

      const response = await subscription.stream.stream({
        offset: startOffset,
        live: "sse",
        signal: subscription.abortController!.signal,
      });

      console.log(`[stream-store] Starting subscribeText for ${streamPath}`);
      const subscribeStart = performance.now();
      let chunkCount = 0;

      response.subscribeText((chunk) => {
        chunkCount++;
        const elapsed = performance.now() - subscribeStart;
        console.log(`[stream-store] Chunk #${chunkCount} received at ${elapsed.toFixed(0)}ms, offset=${chunk.offset}, len=${chunk.text.length}`);

        if (chunk.text !== "") {
          // Queue message for batched processing
          subscription.pendingMessages.push({ offset: chunk.offset, data: chunk.text });

          // Schedule flush if not already scheduled
          if (!subscription.flushScheduled) {
            subscription.flushScheduled = true;
            console.log(`[stream-store] Scheduling flush with ${subscription.pendingMessages.length} pending`);
            queueMicrotask(() => this.flushPendingMessages(subscription));
          }
        }
        return Promise.resolve();
      });
    } catch (err: unknown) {
      // Ignore abort errors - expected when navigating away or during cleanup
      const error = err as { name?: string; message?: string };
      const isAbortError =
        error.name === "AbortError" ||
        error.message?.includes("aborted") ||
        error.message?.includes("abort");

      if (!isAbortError) {
        console.error(`Failed to follow stream ${streamPath}:`, error.message);
      }
    }
  }
}

export const streamStore = new StreamStore();
