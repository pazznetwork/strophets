export interface PromiseWrapper<T> {
  isResolved: boolean;
  isPending: boolean;
  isRejected: boolean;
  resolve?: (value: T | PromiseLike<T>) => void;
  reject: (reason?: any) => void;
}
