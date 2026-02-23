export type ReconnectDelayOverrideArgs = {
    type: 'close' | 'error';
    code?: number;
    reason?: string | Buffer;
    err?: Error;
  };