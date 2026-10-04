import { NotImplementedError } from "./errors.js";

// Stubs stop the call. The casts keep each stage's real signature.

export function unimplemented<T extends (...args: never[]) => Promise<unknown>>(
  feature: string,
): T {
  const fn = (..._args: readonly unknown[]): Promise<never> =>
    Promise.reject(new NotImplementedError(feature));
  return fn as unknown as T;
}

export function unimplementedSync<T extends (...args: never[]) => unknown>(feature: string): T {
  const fn = (..._args: readonly unknown[]): never => {
    throw new NotImplementedError(feature);
  };
  return fn as unknown as T;
}
