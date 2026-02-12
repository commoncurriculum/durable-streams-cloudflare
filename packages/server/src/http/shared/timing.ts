export type TimingEntry = {
  name: string;
  durationMs: number;
  description?: string;
};

export class Timing {
  private entries: TimingEntry[] = [];

  start(name: string, description?: string): () => void {
    const started = performance.now();
    return () => {
      const durationMs = performance.now() - started;
      this.record(name, durationMs, description);
    };
  }

  record(name: string, durationMs: number, description?: string): void {
    if (!Number.isFinite(durationMs)) return;
    this.entries.push({ name, durationMs, description });
  }

  isEmpty(): boolean {
    return this.entries.length === 0;
  }

  toHeaderValue(): string {
    return this.entries
      .map((entry) => {
        const dur = entry.durationMs.toFixed(2);
        const desc = entry.description ? `;desc="${entry.description}"` : "";
        return `${entry.name};dur=${dur}${desc}`;
      })
      .join(", ");
  }
}

export function appendServerTiming(
  headers: Headers,
  timing: Timing | null
): void {
  if (!timing || timing.isEmpty()) return;
  const value = timing.toHeaderValue();
  if (!value) return;
  const existing = headers.get("Server-Timing");
  if (existing) {
    headers.set("Server-Timing", `${existing}, ${value}`);
    return;
  }
  headers.set("Server-Timing", value);
}

export function attachTiming(
  response: Response,
  timing: Timing | null
): Response {
  if (!timing || timing.isEmpty()) return response;
  const headers = new Headers(response.headers);
  appendServerTiming(headers, timing);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
