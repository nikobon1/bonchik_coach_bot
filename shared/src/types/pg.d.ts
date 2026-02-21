declare module 'pg' {
  export type QueryResult = {
    rows: unknown[];
    rowCount?: number | null;
  };

  export interface PoolClient {
    query(text: string, values?: unknown[]): Promise<QueryResult>;
    release(): void;
  }

  export class Pool {
    constructor(config?: {
      connectionString?: string;
      max?: number;
      idleTimeoutMillis?: number;
      connectionTimeoutMillis?: number;
    });
    query(text: string, values?: unknown[]): Promise<QueryResult>;
    connect(): Promise<PoolClient>;
    end(): Promise<void>;
  }
}
