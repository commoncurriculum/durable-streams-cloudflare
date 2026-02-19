export const MAX_RECENT_ESTUARIES = 20;

const STORAGE_KEY_PREFIX = "recent-estuaries:";

export interface RecentEstuary {
  estuaryId: string;
  createdAt: number;
}

function storageKey(projectId: string): string {
  return `${STORAGE_KEY_PREFIX}${projectId}`;
}

export function getRecentEstuaries(projectId: string): RecentEstuary[] {
  try {
    const raw = localStorage.getItem(storageKey(projectId));
    if (!raw) return [];
    return JSON.parse(raw) as RecentEstuary[];
  } catch {
    return [];
  }
}

export function addRecentEstuary(projectId: string, estuaryId: string): void {
  const estuaries = getRecentEstuaries(projectId).filter((e) => e.estuaryId !== estuaryId);
  estuaries.unshift({ estuaryId, createdAt: Date.now() });
  if (estuaries.length > MAX_RECENT_ESTUARIES) {
    estuaries.length = MAX_RECENT_ESTUARIES;
  }
  localStorage.setItem(storageKey(projectId), JSON.stringify(estuaries));
}
