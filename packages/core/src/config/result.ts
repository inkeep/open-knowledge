/**
 * `Result<T, E>` — discriminated success/failure type used at every config
 * write boundary (`writeConfigPatch`, `applyFolderRulesUpsert`,
 * `ConfigBinding.patch`). Errors are values, not exceptions; throws are
 * reserved for programmer errors only.
 *
 * Success spreads the payload into the result so callers can `result.applied`
 * directly inside the narrowed branch. Failure carries `error: E`.
 */
export type Ok<T> = { ok: true } & T;
export type Err<E> = { ok: false; error: E };
export type Result<T, E> = Ok<T> | Err<E>;
