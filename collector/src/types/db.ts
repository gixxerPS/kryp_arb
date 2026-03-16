export type DpClient = {
  query: (sql: string, values?: unknown[]) => Promise<unknown>;
  release: () => void;
};

export type DbInsert = {
  sql: string;
  values: Array<string | number | Date | null>;
};

export type DpPool = {
  query: (sql: string, values?: unknown[]) => Promise<unknown>;
  connect?: () => Promise<DpClient>;
};
