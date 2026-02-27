export type DpPool = {
  query: (sql: string, values?: unknown[]) => Promise<unknown>;
};

