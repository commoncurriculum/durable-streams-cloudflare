export type AdminEnv = {
  CORE: Fetcher;
  ADMIN_TOKEN?: string;
  CF_ACCOUNT_ID?: string;
  CF_API_TOKEN?: string;
  CORE_PUBLIC_URL?: string;
};

export type AnalyticsRow = Record<string, string | number | null>;

export type SystemStats = {
  eventType: string;
  total: number;
  totalBytes: number;
};

export type StreamListItem = {
  streamId: string;
  firstSeen: string;
  lastSeen: string;
  totalEvents: number;
};

export type HotStream = {
  streamId: string;
  events: number;
  bytes: number;
};

export type TimeseriesBucket = {
  bucket: number;
  eventType: string;
  total: number;
  bytes: number;
};
