/**
 * Shared prefix on OK's shipped starter-pack skills (`open-knowledge-pack-<packId>`,
 * and `open-knowledge-pack-<packId>-<member>` for a decomposed pack's members).
 *
 * Structurally load-bearing: it exempts pack skills from the reserved-name install
 * block (`skill-projection.ts`), drives `findPackSkillSource`, and is stripped for
 * display in the browse surfaces. Lives in core so the server and app agree on one
 * value. The Copybara skills-mirror manifest encodes it too — that copy is config,
 * guarded by `check-skills-mirror-complete`.
 */
export const PACK_SKILL_PREFIX = 'open-knowledge-pack-';

/**
 * GitHub `owner/repo` of the public projection skills.sh indexes
 * (`copybara/manifests/public-open-knowledge-skills.json` mirrors the bundled
 * packs here). Recorded as the `.ok/skills-lock.json` source for seeded starter
 * packs so they update through the same reimport path as any imported skill.
 */
export const OPENKNOWLEDGE_SKILLS_REPO = 'inkeep/open-knowledge-skills';

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
