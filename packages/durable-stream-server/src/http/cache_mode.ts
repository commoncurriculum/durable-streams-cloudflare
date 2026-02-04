export type CacheMode = "shared" | "private";

export const CACHE_MODE_HEADER = "X-Cache-Mode";

export function normalizeCacheMode(value: string | null | undefined): CacheMode | null {
  if (!value) return null;
  const lower = value.toLowerCase();
  if (lower === "shared" || lower === "private") return lower;
  return null;
}

export function resolveCacheMode(params: {
  envMode?: string | null;
  authMode?: CacheMode;
}): CacheMode {
  const envMode = normalizeCacheMode(params.envMode ?? null);
  if (envMode) return envMode;
  if (params.authMode) return params.authMode;
  return "private";
}

export function getCacheMode(request: Request): CacheMode {
  return normalizeCacheMode(request.headers.get(CACHE_MODE_HEADER)) ?? "private";
}
