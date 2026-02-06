/** Cloudflare service binding with fetch-like interface */
export interface ServiceBinding {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

export type AdminEnv = {
  CORE: ServiceBinding;
  ADMIN_TOKEN?: string;
  CF_ACCOUNT_ID?: string;
  CF_API_TOKEN?: string;
};

export type AnalyticsRow = Record<string, string | number | null>;
