import { isAbsolute, relative, resolve } from 'node:path';

interface ContainmentOk {
  ok: true;
  abs: string;
  rel: string;
}

interface ContainmentErr {
  ok: false;
  reason: string;
}

type ContainmentResult = ContainmentOk | ContainmentErr;

export function resolveWithinRoot(root: string, candidate: string): ContainmentResult {
  if (typeof root !== 'string' || !isAbsolute(root)) {
    return { ok: false, reason: `root path is not absolute: ${String(root)}` };
  }
  if (typeof candidate !== 'string') {
    return { ok: false, reason: 'path must be a string' };
  }
  if (candidate.includes('\x00')) {
    return { ok: false, reason: 'path contains a NUL byte' };
  }
  const normalizedRoot = resolve(root);
  const abs = resolve(normalizedRoot, candidate);
  const rel = relative(normalizedRoot, abs);
  if (rel === '') {
    return { ok: true, abs, rel: '' };
  }
  if (rel === '..' || rel.startsWith('../') || isAbsolute(rel)) {
    return {
      ok: false,
      reason: `path "${candidate}" escapes the configured root`,
    };
  }
  return { ok: true, abs, rel };
}
