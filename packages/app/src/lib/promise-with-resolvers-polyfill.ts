if (typeof Promise.withResolvers !== 'function') {
  Promise.withResolvers = <T>(): PromiseWithResolvers<T> => {
    let resolve!: PromiseWithResolvers<T>['resolve'];
    let reject!: PromiseWithResolvers<T>['reject'];
    // oxlint-disable-next-line unicorn-js/prefer-promise-with-resolvers -- the fallback for browsers that lack Promise.withResolvers
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  };
}
