/**
 * The vendor-neutral `.agents/skills` hub, cwd-relative (home-relative at global
 * scope). A first-class in-place skill host with no `EditorId` of its own — it is
 * addressed by the `agents` host id, so it is absent from `EDITOR_PROJECT_SKILL_ROOT`
 * and every consumer had spelled it as a bare literal instead. Server, core and app
 * all resolve the same hub, so a change to it has to reach every site at once.
 */
export const AGENTS_SKILLS_ROOT = '.agents/skills';

/**
 * LEGACY prefix the starter-pack skills carried before the marketplace rename
 * (`open-knowledge-pack-<packId>[-<member>]`). It no longer names anything the
 * codebase ships: shipped names come from SKILL.md frontmatter. It survives
 * solely to recognize OLD installs — `retrofitPackLockEntry`'s gate and the
 * keys of {@link RENAMED_PACK_SKILLS}. Never compare shipped skills against it,
 * and never set it to '' (a universal `startsWith('')` match).
 */
export const PACK_SKILL_PREFIX = 'open-knowledge-pack-';

/**
 * Did this lock/import source come from OK's OWN published skills repo? The
 * lock keeps the raw source the user arrived through, so the same bundle records
 * the bare `owner/repo` when seeded or hand-typed and a skills.sh URL naming that
 * repo when installed from a listing.
 *
 * Used for two different decisions, both of which need the loose match: whether a
 * present skill is ours (seed collision classification), and whether an install
 * counts toward our own skills.sh listing. The privacy rule that gates OTHER
 * sources — never announce a repo the user did not choose from the marketplace —
 * does not apply here, because the repo being named is ours.
 */
export function isOpenKnowledgeSkillsSource(source: string): boolean {
  const raw = source.trim();
  if (raw === OPENKNOWLEDGE_SKILLS_REPO) return true;

  // A bare `owner/repo` must match EXACTLY. A substring test reads
  // `notinkeep/open-knowledge-skills` as ours — a third party's repo, in a
  // valid owner/repo shape, which the reporter would then happily announce.
  if (!raw.includes('://') && !raw.includes('@')) return false;

  // Anything else has to name a host we actually publish through, with our repo
  // at the START of the path. Otherwise `evil.example/inkeep/open-knowledge-skills`
  // passes on the strength of a path segment anyone can create.
  if (raw.includes('://')) {
    try {
      const url = new URL(raw);
      return TRUSTED_SKILL_HOSTS.has(url.hostname.toLowerCase()) && pathIsOurRepo(url.pathname);
    } catch {
      return false;
    }
  }
  // scp-style git remote: `git@github.com:inkeep/open-knowledge-skills.git`.
  // Checked AFTER the URL branch — this pattern also matches `https://…`, where
  // it would read the scheme as the host.
  const scp = /^(?:[\w.-]+@)?([\w.-]+):(.+)$/.exec(raw);
  if (scp) return TRUSTED_SKILL_HOSTS.has(scp[1].toLowerCase()) && pathIsOurRepo(scp[2]);
  return false;
}

/** Hosts our skills repo is legitimately served from. */
const TRUSTED_SKILL_HOSTS: ReadonlySet<string> = new Set([
  'skills.sh',
  'www.skills.sh',
  'github.com',
  'www.github.com',
  'raw.githubusercontent.com',
]);

/** Does this URL path name our repo at its root (`.git` suffix tolerated)? */
function pathIsOurRepo(pathname: string): boolean {
  const trimmed = pathname.replace(/^\/+/, '').replace(/\.git$/, '');
  return (
    trimmed === OPENKNOWLEDGE_SKILLS_REPO || trimmed.startsWith(`${OPENKNOWLEDGE_SKILLS_REPO}/`)
  );
}

/**
 * Decision key for a PROJECT's copy of the platform skill, stored in the
 * machine-local `bundles` map alongside the user-global bundle decisions.
 *
 * Exists because the desktop's project-open reclaim creates the project skill
 * for any wired host that lacks one. Without a recorded decision that heals the
 * cohort onboarded before the writer existed — but it also silently reinstates a
 * skill the user just switched OFF in Settings, on the very next open. Keyed by
 * project dir and machine-local on purpose: one teammate's choice must not ride
 * along in the repo.
 */
export function projectSkillDecisionKey(projectDir: string): string {
  return `project-skill:${projectDir}`;
}

/**
 * Old→new names from the 2026-07 pack-skill rename (marketplace short names).
 * Existing installs are NEVER renamed, so this map is only ever read
 * old-name-first — it never writes a new name onto anyone's disk. Live
 * consumers: the import and reimport selectors, which resolve an old-name
 * request against the renamed mirror bundle; the seed path, which counts an
 * old-name install as present so re-seeding authors no duplicate; and the
 * reserved-name gate, which keeps these exact old names installable. This is the ONLY
 * old→new map in the codebase — tests and mirror machinery must not carry a
 * copy of it.
 *
 *
 * ENTRIES ARE PERMANENT. Existing installs are never renamed, so an old name can
 * be on someone's disk indefinitely — and every consumer here reads old-name
 * first. Deleting an entry silently breaks that install's Update, its seed
 * presence check (a duplicate gets authored beside it), and its reserved-name
 * exemption (it stops being installable at all). Add entries; do not remove them.
 */
export const RENAMED_PACK_SKILLS: Readonly<Record<string, string>> = {
  'open-knowledge-pack-plain-notes': 'note-taking',
  'open-knowledge-pack-worldbuilding': 'worldbuilding',
  'open-knowledge-pack-writing-pipeline': 'writing-workflow',
  'open-knowledge-pack-codebase-wiki': 'codebase-wiki',
  'open-knowledge-pack-knowledge-base': 'knowledge-base',
  'open-knowledge-pack-software-lifecycle': 'software-lifecycle',
  'open-knowledge-pack-entity-vault': 'personal-crm',
  'open-knowledge-pack-okf': 'okf-knowledge-base',
  'open-knowledge-pack-software-lifecycle-frame-a-proposal': 'frame-a-proposal',
  'open-knowledge-pack-software-lifecycle-record-a-decision': 'record-a-decision',
  'open-knowledge-pack-software-lifecycle-write-a-spec': 'write-a-spec',
  'open-knowledge-pack-software-lifecycle-review-a-design': 'review-a-design',
  'open-knowledge-pack-software-lifecycle-write-a-postmortem': 'write-a-postmortem',
  'open-knowledge-pack-knowledge-base-research': 'research-with-sources',
  'open-knowledge-pack-knowledge-base-consolidate': 'consolidate-notes',
};

/**
 * GitHub `owner/repo` of the public projection skills.sh indexes
 * (`copybara/manifests/public-open-knowledge-skills.json` mirrors the bundled
 * packs here). Recorded as the `.ok/skills-lock.json` source for seeded starter
 * packs so they update through the same reimport path as any imported skill.
 */
export const OPENKNOWLEDGE_SKILLS_REPO = 'inkeep/open-knowledge-skills';

/**
 * Is this discovery row one of OUR listings under the retired pack-skill names?
 * The 2026-07 rename left the old `open-knowledge-pack-*` listings live on
 * skills.sh beside their renamed twins, so an unfiltered directory shows both
 * and the stale one installs a bundle we no longer publish. Discovery hides
 * them; {@link RENAMED_PACK_SKILLS} still resolves them for anyone who already
 * installed one. Scoped to our own repo — a third party's `open-knowledge-pack-`
 * skill is theirs to list.
 */
export function isRetiredPackListing(name: string, source: string): boolean {
  return name.startsWith(PACK_SKILL_PREFIX) && isOpenKnowledgeSkillsSource(source);
}

/**
 * Standalone `/skill-name` reference token in skill-doc prose — the cross-agent
 * invocation convention ("Load /structured-thinking"). Requires a word boundary
 * before and no path continuation after (a second `/` means it's a filesystem
 * path, not a skill). Common absolute-path roots are stop-listed to keep prose
 * like `/tmp` inert. Shared by the editor decorations (both surfaces) and the
 * server backlink index (skill-ref graph edges) — one grammar, one behavior.
 */
export const SKILL_REF_RE = /(^|[\s([])\/([a-z0-9][a-z0-9-]{1,63})(?=$|[\s.,;:!?)\]])/g;

const SKILL_REF_STOPLIST = new Set([
  'tmp',
  'usr',
  'etc',
  'var',
  'dev',
  'opt',
  'bin',
  'api',
  'home',
  'root',
]);

export function isSkillRefCandidate(slug: string): boolean {
  return !SKILL_REF_STOPLIST.has(slug);
}

/** Whole-span inline-code form of the same convention: `` `/skill-name` ``. */
const SKILL_REF_CODE_RE = /`\/([a-z0-9][a-z0-9-]{1,63})`/g;

/**
 * Extract every distinct `/skill-name` reference from a skill doc's markdown
 * body — prose tokens (SKILL_REF_RE) plus whole inline-code spans. Order is
 * first-seen; stop-listed roots excluded.
 */
export function extractSkillRefs(body: string): string[] {
  const out = new Set<string>();
  SKILL_REF_RE.lastIndex = 0;
  for (let m = SKILL_REF_RE.exec(body); m !== null; m = SKILL_REF_RE.exec(body)) {
    const slug = m[2] as string;
    if (isSkillRefCandidate(slug)) out.add(slug);
  }
  SKILL_REF_CODE_RE.lastIndex = 0;
  for (let m = SKILL_REF_CODE_RE.exec(body); m !== null; m = SKILL_REF_CODE_RE.exec(body)) {
    const slug = m[1] as string;
    if (isSkillRefCandidate(slug)) out.add(slug);
  }
  return [...out];
}

/**
 * Rewrite every `/from` reference in a skill body to `/to`.
 *
 * Symmetry with `extractSkillRefs` is the contract, not an accident: an
 * occurrence that draws a graph edge is exactly the occurrence a rename has to
 * carry, and one that draws no edge must be left alone. Both forms the
 * extractor reads (prose token, whole inline-code span) are rewritten; anything
 * it ignores — a path continuation like `/from/x`, a stop-listed root — is not.
 *
 * Skill refs are resolved by NAME at read time rather than stored as paths, so
 * without this a rename silently drops every inbound edge: the referencing body
 * still says `/from`, nothing answers to that name, and dead-link detection
 * never sees it (skill refs are computed, so they never enter the backward map).
 */
export function rewriteSkillRefs(body: string, from: string, to: string): string {
  if (from === to || !isSkillRefCandidate(from) || !body.includes(`/${from}`)) return body;
  SKILL_REF_RE.lastIndex = 0;
  const prose = body.replace(SKILL_REF_RE, (match, lead: string, slug: string) =>
    slug === from ? `${lead}/${to}` : match,
  );
  SKILL_REF_CODE_RE.lastIndex = 0;
  return prose.replace(SKILL_REF_CODE_RE, (match, slug: string) =>
    slug === from ? `\`/${to}\`` : match,
  );
}
