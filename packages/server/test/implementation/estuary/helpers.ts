// Helper utilities for Estuary integration tests

export const uniqueStreamId = (prefix?: string) => {
  const uuid = crypto.randomUUID();
  return `${prefix || ""}${uuid}`;
};
