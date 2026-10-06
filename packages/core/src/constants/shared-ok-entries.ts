import { INSTALLED_SKILLS_FILENAME } from '../installed-skills/schema.ts';
import { SKILLS_LOCK_FILENAME } from '../skills-catalog/acquire/lockfile.ts';
import { LOCAL_DIR } from './ok-dir.ts';

export const MACHINE_ID_FILENAME = 'machine-id';

export const SKILLS_STORE_DIRNAME = 'skills';

export const SKILL_PLACEMENTS_FILENAME = 'skill-placements.json';

export const SKILL_MOVE_RETAINED_FILENAME = 'skill-move-retained.json';

export const SERVER_AUTHORITY_REGISTRY_FILENAME = 'server-authority.sqlite';

export const SERVER_AUTHORITY_LEASES_DIRNAME = 'server-authority-leases';

export const SHARED_OK_ENTRIES: readonly string[] = [
  MACHINE_ID_FILENAME,
  SKILLS_STORE_DIRNAME,
  SKILLS_LOCK_FILENAME,
  `${LOCAL_DIR}/${INSTALLED_SKILLS_FILENAME}`,
  `${LOCAL_DIR}/${SKILL_PLACEMENTS_FILENAME}`,
  `${LOCAL_DIR}/${SKILL_MOVE_RETAINED_FILENAME}`,
  `${LOCAL_DIR}/${SERVER_AUTHORITY_REGISTRY_FILENAME}`,
  `${LOCAL_DIR}/${SERVER_AUTHORITY_REGISTRY_FILENAME}-journal`,
  `${LOCAL_DIR}/${SERVER_AUTHORITY_LEASES_DIRNAME}`,
];
