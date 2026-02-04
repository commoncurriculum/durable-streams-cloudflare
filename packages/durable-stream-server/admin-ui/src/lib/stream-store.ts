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
        live: "long-poll",
        signal: subscription.abortController!.signal,
      });

      response.subscribeText((chunk) => {
        if (chunk.text !== "") {
          // Create new array reference so React detects the change
          // Limit array size to prevent unbounded memory growth
          const newMessages = [
            ...subscription.messages,
            { offset: chunk.offset, data: chunk.text },
          ];
          subscription.messages =
            newMessages.length > MAX_MESSAGES_PER_STREAM
              ? newMessages.slice(-MAX_MESSAGES_PER_STREAM)
              : newMessages;
          // Notify all listeners
          subscription.listeners.forEach((listener) => listener());
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
