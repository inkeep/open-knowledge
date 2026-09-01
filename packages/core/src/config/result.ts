export type Ok<T> = { ok: true } & T;
export type Err<E> = { ok: false; error: E };
export type Result<T, E> = Ok<T> | Err<E>;
