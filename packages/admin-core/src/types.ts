export interface CoreService {
  inspectStream(doKey: string): Promise<object>;
  routeRequest(doKey: string, request: Request): Promise<Response>;
  putStream(doKey: string, options: { body?: ArrayBuffer; contentType?: string }): Promise<{ ok: boolean; status: number }>;
  postStream(
    doKey: string,
    payload: ArrayBuffer,
    contentType: string,
  ): Promise<{ ok: boolean; status: number; nextOffset: string | null; body: string | null }>;
  readStream(
    doKey: string,
    offset: string,
  ): Promise<{ ok: boolean; status: number; body: string; nextOffset: string | null; upToDate: boolean; contentType: string }>;
  
  // Project management RPCs
  registerProject(projectId: string, signingSecret: string): Promise<void>;
  listProjects(): Promise<string[]>;
  getProjectConfig(projectId: string): Promise<{
    signingSecrets: string[];
    corsOrigins?: string[];
    isPublic?: boolean;
  } | null>;
  addSigningKey(projectId: string, newSecret: string): Promise<{ keyCount: number }>;
  removeSigningKey(projectId: string, secretToRemove: string): Promise<{ keyCount: number }>;
  addCorsOrigin(projectId: string, origin: string): Promise<void>;
  removeCorsOrigin(projectId: string, origin: string): Promise<void>;
  updatePrivacy(projectId: string, isPublic: boolean): Promise<void>;
  
  // Stream metadata RPCs
  getStreamMetadata(doKey: string): Promise<{
    public: boolean;
    content_type: string;
    created_at: number;
    readerKey?: string;
  } | null>;
}

export type AnalyticsRow = Record<string, string | number | null>;
