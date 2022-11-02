import { PromiseWrapper } from './promise-wrapper';

export function getOpenPromise<T>(): Promise<T> & PromiseWrapper<T> {
  let wrapper: PromiseWrapper<T>;
  const promise = Object.assign(
    new Promise<T>((resolve, reject) => {
      wrapper = {
        isResolved: false,
        isPending: true,
        isRejected: false,
        resolve,
        reject
      };
    }),
    wrapper
  );
  promise.then(
    function (v) {
      promise.isResolved = true;
      promise.isPending = false;
      promise.isRejected = false;
      return v;
    },
    function (e) {
      promise.isResolved = false;
      promise.isPending = false;
      promise.isRejected = true;
      throw e;
    }
  );
  return promise;
}
