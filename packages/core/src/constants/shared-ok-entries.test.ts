import { describe, expect, test } from 'vitest';
import { INSTALLED_SKILLS_REL } from '../installed-skills/schema.ts';
import { SKILLS_LOCK_REL } from '../skills-catalog/acquire/lockfile.ts';
import { LOCAL_DIR, OK_DIR } from './ok-dir.ts';
import {
  MACHINE_ID_FILENAME,
  SERVER_AUTHORITY_LEASES_DIRNAME,
  SERVER_AUTHORITY_REGISTRY_FILENAME,
  SHARED_OK_ENTRIES,
  SKILL_MOVE_RETAINED_FILENAME,
  SKILL_PLACEMENTS_FILENAME,
  SKILLS_STORE_DIRNAME,
} from './shared-ok-entries.ts';

function okRelative(rel: readonly string[]): string {
  expect(rel[0]).toBe(OK_DIR);
  return rel.slice(1).join('/');
}

describe('SHARED_OK_ENTRIES', () => {
  test('each entry is the path its writer uses under the OK dir', () => {
    expect([...SHARED_OK_ENTRIES]).toEqual([
      'machine-id',
      'skills',
      'skills-lock.json',
      'local/installed-skills.json',
      'local/skill-placements.json',
      'local/skill-move-retained.json',
      'local/server-authority.sqlite',
      'local/server-authority.sqlite-journal',
      'local/server-authority-leases',
    ]);
    expect(SHARED_OK_ENTRIES).toEqual([
      MACHINE_ID_FILENAME,
      SKILLS_STORE_DIRNAME,
      okRelative(SKILLS_LOCK_REL),
      okRelative(INSTALLED_SKILLS_REL),
      `${LOCAL_DIR}/${SKILL_PLACEMENTS_FILENAME}`,
      `${LOCAL_DIR}/${SKILL_MOVE_RETAINED_FILENAME}`,
      `${LOCAL_DIR}/${SERVER_AUTHORITY_REGISTRY_FILENAME}`,
      `${LOCAL_DIR}/${SERVER_AUTHORITY_REGISTRY_FILENAME}-journal`,
      `${LOCAL_DIR}/${SERVER_AUTHORITY_LEASES_DIRNAME}`,
    ]);
  });
});
