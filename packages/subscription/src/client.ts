/**
 * Shared helper for communicating with the core durable-streams worker.
 * Uses service binding when available for better performance (no network hop, no auth needed).
 */

export interface CoreClientEnv {
  CORE?: Fetcher; // Service binding to core worker
  CORE_URL: string;
  AUTH_TOKEN?: string;
}

/**
 * Fetch from core worker using service binding if available, otherwise use HTTP.
 * Service bindings are faster (no network hop) and don't require auth.
 */
export function fetchFromCore(
  env: CoreClientEnv,
  path: string,
  options?: RequestInit,
): Promise<Response> {
  if (env.CORE) {
    // Use service binding - no auth needed, faster internal routing
    return env.CORE.fetch(new Request(`https://internal${path}`, options));
  }

  // Fall back to HTTP fetch
  const headers: Record<string, string> = {};
  if (env.AUTH_TOKEN) {
    headers.Authorization = `Bearer ${env.AUTH_TOKEN}`;
  }
  if (options?.headers) {
    Object.assign(headers, options.headers);
  }

  return fetch(`${env.CORE_URL}${path}`, {
    ...options,
    headers,
  });
}
