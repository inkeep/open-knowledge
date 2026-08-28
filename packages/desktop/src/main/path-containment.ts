// Compatibility facade for main-process imports; the implementation is shared
// with utility-process call sites so both process boundaries enforce one rule.
export { isPathWithinProject, validateSpawnPath } from '../shared/path-containment.ts';
