export type LockResult =
  | { status: 'ACQUIRED' }
  | {
      status: 'COLLISION';
      currentState: 'PROCESSING' | 'COMPLETED' | 'UNKNOWN';
    };
