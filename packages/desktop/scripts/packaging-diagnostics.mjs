#!/usr/bin/env node
export const FUSE_FAILURE_MARKER = 'OK_PACKAGING_FUSE_FAILURE';
export const UPDATE_MANIFEST_FAILURE_MARKER = 'OK_PACKAGING_UPDATE_MANIFEST_FAILURE';

export function createFuseFailure(message, options) {
  return new Error(`${message} [${FUSE_FAILURE_MARKER}]`, options);
}
