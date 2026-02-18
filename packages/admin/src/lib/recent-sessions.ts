export const MAX_RECENT_SESSIONS = 20;

const STORAGE_KEY_PREFIX = "recent-sessions:";

export interface RecentSession {
  sessionId: string;
  createdAt: number;
}

function storageKey(projectId: string): string {
  return `${STORAGE_KEY_PREFIX}${projectId}`;
}

export function getRecentSessions(projectId: string): RecentSession[] {
  try {
    const raw = localStorage.getItem(storageKey(projectId));
    if (!raw) return [];
    return JSON.parse(raw) as RecentSession[];
  } catch {
    return [];
  }
}

export function addRecentSession(projectId: string, sessionId: string): void {
  const sessions = getRecentSessions(projectId).filter((s) => s.sessionId !== sessionId);
  sessions.unshift({ sessionId, createdAt: Date.now() });
  if (sessions.length > MAX_RECENT_SESSIONS) {
    sessions.length = MAX_RECENT_SESSIONS;
  }
  localStorage.setItem(storageKey(projectId), JSON.stringify(sessions));
}
