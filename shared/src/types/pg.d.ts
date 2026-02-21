declare module 'pg' {
  export class Pool {
    constructor(config?: {
      connectionString?: string;
      max?: number;
      idleTimeoutMillis?: number;
      connectionTimeoutMillis?: number;
    });
    query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }>;
    end(): Promise<void>;
  }
}