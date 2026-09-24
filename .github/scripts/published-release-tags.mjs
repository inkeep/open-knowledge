/* biome-ignore-all lint/suspicious/noUndeclaredEnvVars: GitHub Actions invokes this entrypoint outside Turbo. */
import { execFileSync } from 'node:child_process';

const STABLE_TAG_RE = /^v(\d+)\.(\d+)\.(\d+)$/;
const BETA_TAG_RE = /^v(\d+)\.(\d+)\.(\d+)-beta\.(\d+)$/;

function releaseTagKey(raw) {
  const line = String(raw).trim();
  const stable = STABLE_TAG_RE.exec(line);
  if (stable) {
    return { tag: stable[0], key: [Number(stable[1]), Number(stable[2]), Number(stable[3]), 1, 0] };
  }
  const beta = BETA_TAG_RE.exec(line);
  if (beta) {
    return {
      tag: beta[0],
      key: [Number(beta[1]), Number(beta[2]), Number(beta[3]), 0, Number(beta[4])],
    };
  }
  return null;
}

function byReleaseKeyAscending(a, b) {
  for (let i = 0; i < a.key.length; i += 1) {
    if (a.key[i] !== b.key[i]) return a.key[i] - b.key[i];
  }
  return 0;
}

export function sortReleaseTagsAscending(rawTags) {
  const parsed = [];
  for (const line of rawTags) {
    const entry = releaseTagKey(line);
    if (entry) parsed.push(entry);
  }
  parsed.sort(byReleaseKeyAscending);
  return parsed.map((p) => p.tag);
}

export function publishedReleaseTags(releases) {
  return sortReleaseTagsAscending(
    releases
      .filter(
        (release) =>
          release.draft === false &&
          Number.isFinite(Date.parse(release.published_at)) &&
          release.assets?.some((asset) => asset.name.endsWith('.dmg')) &&
          release.assets?.some((asset) => asset.name.endsWith('-mac.yml')),
      )
      .map((release) => release.tag_name),
  );
}

export function requirePublishedRelease(tag, tags) {
  if (!tags.includes(tag))
    throw new Error(
      `${tag} is not a published desktop release with installers; refusing release writeback`,
    );
}

export function previousPublishedRelease(tag, tags) {
  const sorted = sortReleaseTagsAscending(tags);
  requirePublishedRelease(tag, sorted);
  return sorted[sorted.indexOf(tag) - 1] ?? null;
}

export function realPublishedReleaseTags(
  repo = process.env.GITHUB_REPOSITORY || 'inkeep/open-knowledge',
) {
  const output = execFileSync(
    'gh',
    [
      'api',
      `repos/${repo}/releases?per_page=100`,
      '--paginate',
      '--jq',
      '.[] | {tag_name,draft,published_at,assets:[.assets[] | {name}]}',
    ],
    { encoding: 'utf8', timeout: 120_000, maxBuffer: 32 * 1024 * 1024 },
  );
  return publishedReleaseTags(
    output
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line)),
  );
}
