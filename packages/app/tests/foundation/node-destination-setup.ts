import { afterEach, beforeEach } from 'vitest';
import { refuseDomGlobals } from './node-dom-globals';

beforeEach(() => refuseDomGlobals('before this test runs'));

afterEach(() => refuseDomGlobals('after this test ran'));
