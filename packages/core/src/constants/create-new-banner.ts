/**
 * Cascade-banner discriminator for the Create new project dialog. Drives:
 *   - the renderer's banner-shown telemetry dedup (one per dialog open)
 *   - the main-process recordCreateNewBannerShown handler's banner attribute
 *   - the corresponding span attribute on ok.desktop.createNewBannerShown
 *
 *  - `'nested'`      — banner shown when parent is inside an existing OK project.
 *  - `'nonempty'`    — banner shown when target folder exists with content.
 *  - `'git-confirm'` — banner shown when parent is inside a git repo (no .ok/).
 */
export type CreateNewBannerKind = 'nested' | 'nonempty' | 'git-confirm';
