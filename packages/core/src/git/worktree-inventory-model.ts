export type WorktreeInventoryLocation = 'primary' | 'internal' | 'external' | 'unknown';

export type WorktreeInventoryAvailability = 'available' | 'missing' | 'unreadable';

export interface WorktreeInventoryEntry {
  readonly checkoutRoot: string;
  readonly projectPath: string;
  readonly branch: string | null;
  readonly headSha: string | null;
  readonly location: WorktreeInventoryLocation;
  readonly availability: WorktreeInventoryAvailability;
  readonly locked: boolean;
  readonly prunable: boolean;
}

export interface WorktreeInventoryModel {
  readonly gitCommonDir: string;
  readonly primaryCheckoutRoot: string;
  readonly projectSubPath: string;
  readonly entries: readonly WorktreeInventoryEntry[];
}

export interface WorktreeInventoryRequest {
  readonly projectPath: string;
}

export type WorktreeInventoryResult =
  | { readonly ok: true; readonly inventory: WorktreeInventoryModel }
  | {
      readonly ok: false;
      readonly reason: 'invalid-request' | 'no-git' | 'enumeration-failed';
    };

export interface WorktreeInventoryOpenRequest {
  readonly anchorProjectPath: string;
  readonly gitCommonDir: string;
  readonly projectSubPath: string;
  readonly checkoutRoot: string;
  readonly projectPath: string;
}

export type WorktreeInventoryOpenResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason:
        | 'invalid-request'
        | 'no-git'
        | 'enumeration-failed'
        | 'repository-changed'
        | 'not-registered'
        | 'project-unavailable'
        | 'prunable'
        | 'open-failed';
    };
