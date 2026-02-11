export const PROJECT_ID = "test-project";

export function uniqueEstuaryId(_prefix?: string): string {
  return crypto.randomUUID();
}

export function uniqueStreamId(prefix = "stream"): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitFor(
  fn: () => Promise<void>,
  { timeout = 5000, interval = 50 } = {},
): Promise<void> {
  const deadline = Date.now() + timeout;
  let lastError: Error | undefined;
  while (Date.now() < deadline) {
    try { await fn(); return; }
    catch (err) { lastError = err instanceof Error ? err : new Error(String(err)); }
    await delay(interval);
  }
  throw lastError ?? new Error("waitFor timed out");
}

export interface SubscriptionsClient {
  subscribe(estuaryId: string, streamId: string, contentType?: string): Promise<Response>;
  unsubscribe(estuaryId: string, streamId: string): Promise<Response>;
  publish(streamId: string, payload: string, contentType?: string): Promise<Response>;
  getEstuary(estuaryId: string): Promise<Response>;
  touchEstuary(estuaryId: string): Promise<Response>;
  deleteEstuary(estuaryId: string): Promise<Response>;
}

export function createSubscriptionsClient(baseUrl: string): SubscriptionsClient {
  return {
    async subscribe(estuaryId: string, streamId: string, _contentType = "application/json") {
      return fetch(`${baseUrl}/v1/estuary/subscribe/${PROJECT_ID}/${streamId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ estuaryId }),
      });
    },

    async unsubscribe(estuaryId: string, streamId: string) {
      return fetch(`${baseUrl}/v1/estuary/subscribe/${PROJECT_ID}/${streamId}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ estuaryId }),
      });
    },

    async publish(streamId: string, payload: string, contentType = "application/json") {
      return fetch(`${baseUrl}/v1/estuary/publish/${PROJECT_ID}/${streamId}`, {
        method: "POST",
        headers: { "Content-Type": contentType },
        body: payload,
      });
    },

    async getEstuary(estuaryId: string) {
      return fetch(`${baseUrl}/v1/estuary/${PROJECT_ID}/${estuaryId}`);
    },

    async touchEstuary(estuaryId: string) {
      return fetch(`${baseUrl}/v1/estuary/${PROJECT_ID}/${estuaryId}`, {
        method: "POST",
      });
    },

    async deleteEstuary(estuaryId: string) {
      return fetch(`${baseUrl}/v1/estuary/${PROJECT_ID}/${estuaryId}`, {
        method: "DELETE",
      });
    },

  };
}

export interface CoreClient {
  createStream(streamId: string, content?: string, contentType?: string): Promise<Response>;
  appendStream(streamId: string, content: string, contentType?: string): Promise<Response>;
  readStream(streamId: string, offset?: string): Promise<Response>;
  readStreamText(streamId: string, offset?: string): Promise<string>;
  deleteStream(streamId: string): Promise<Response>;
  getStreamHead(streamId: string): Promise<Response>;
}

export function createCoreClient(baseUrl: string): CoreClient {
  return {
    async createStream(streamId: string, content = "", contentType = "application/json") {
      // Only include body if content is non-empty.
      // Node.js fetch may strip Content-Type header when body is empty string.
      const options: RequestInit = {
        method: "PUT",
        headers: { "Content-Type": contentType },
      };
      if (content) {
        options.body = content;
      }
      return fetch(`${baseUrl}/v1/stream/${PROJECT_ID}/${streamId}`, options);
    },

    async appendStream(streamId: string, content: string, contentType = "application/json") {
      return fetch(`${baseUrl}/v1/stream/${PROJECT_ID}/${streamId}`, {
        method: "POST",
        headers: { "Content-Type": contentType },
        body: content,
      });
    },

    async readStream(streamId: string, offset = "0000000000000000_0000000000000000") {
      return fetch(`${baseUrl}/v1/stream/${PROJECT_ID}/${streamId}?offset=${offset}`);
    },

    async readStreamText(streamId: string, offset = "0000000000000000_0000000000000000") {
      const response = await this.readStream(streamId, offset);
      if (!response.ok) {
        throw new Error(`Failed to read stream: ${response.status}`);
      }
      return response.text();
    },

    async deleteStream(streamId: string) {
      return fetch(`${baseUrl}/v1/stream/${PROJECT_ID}/${streamId}`, {
        method: "DELETE",
      });
    },

    async getStreamHead(streamId: string) {
      return fetch(`${baseUrl}/v1/stream/${PROJECT_ID}/${streamId}`, {
        method: "HEAD",
      });
    },
  };
}

export interface SubscribeResponse {
  estuaryId: string;
  streamId: string;
  estuaryStreamPath: string;
  expiresAt: number;
  isNewEstuary: boolean;
}

export interface EstuaryResponse {
  estuaryId: string;
  estuaryStreamPath: string;
  subscriptions: Array<{
    streamId: string;
  }>;
}

export interface TouchResponse {
  estuaryId: string;
  expiresAt: number;
}
