export const customFetch = <T>(
  url: string,
  options?: RequestInit,
): Promise<T> => {
  return fetch(url, options).then(async (response) => {
    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: response.statusText }));
      throw error;
    }
    
    // Handle empty responses
    const text = await response.text();
    if (!text) return {} as T;
    
    try {
      return JSON.parse(text) as T;
    } catch {
      return text as T;
    }
  });
};

export default customFetch;

export type ErrorType<T> = T;
