import type { ExecutorRuntimeState } from './executor';

export type PersistentStore = {
  runtimeState?: ExecutorRuntimeState;
  [k: string]: unknown;
};
