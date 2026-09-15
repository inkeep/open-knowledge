#!/usr/bin/env node
export const FUSE_FAILURE_MARKER = 'OK_PACKAGING_FUSE_FAILURE';

export function createFuseFailure(message, options) {
  return new Error(`${message} [${FUSE_FAILURE_MARKER}]`, options);
}
