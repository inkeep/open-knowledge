import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const directory = mkdtempSync(join(tmpdir(), 'ok-test-authority-'));
export const testAuthorityRegistryPath = join(directory, 'authority.sqlite');

process.once('exit', () => rmSync(directory, { recursive: true, force: true }));
