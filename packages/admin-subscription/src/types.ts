export type AdminSubscriptionEnv = {
  SUBSCRIPTION: Fetcher;
  CF_ACCOUNT_ID?: string;
  CF_API_TOKEN?: string;
  ADMIN_TOKEN?: string;
  SUBSCRIPTION_PUBLIC_URL?: string;
  CORE_PUBLIC_URL?: string;
};

export type AnalyticsRow = Record<string, string | number | null>;
