export type LockResult =
  | { status: 'ACQUIRED' }
  | {
      status: 'COLLISION';
      currentState: 'PROCESSING' | 'COMPLETED' | 'UNKNOWN';
    };

export interface RedisConfig {
  host: string;
  port: number;
  password?: string;
  db?: number;
  retryStrategy?: (times: number) => number | void;
}

export type RedisValue = string | number | Buffer;
