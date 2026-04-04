declare module 'pg' {
  export class Pool {
    constructor(config?: Record<string, unknown>);
    query(sql: string, values?: unknown[]): Promise<unknown>;
    connect(): Promise<{
      query: (sql: string, values?: unknown[]) => Promise<unknown>;
      release: () => void;
    }>;
    on(event: 'error', listener: (err: unknown) => void): void;
    end(): Promise<void>;
  }
}
