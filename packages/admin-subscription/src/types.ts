/** Cloudflare service binding with fetch-like interface */
export interface ServiceBinding {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

export type AdminSubscriptionEnv = {
  SUBSCRIPTION: ServiceBinding;
  CORE: ServiceBinding;
  CF_ACCOUNT_ID?: string;
  CF_API_TOKEN?: string;
  ADMIN_TOKEN?: string;
};

export type AnalyticsRow = Record<string, string | number | null>;
