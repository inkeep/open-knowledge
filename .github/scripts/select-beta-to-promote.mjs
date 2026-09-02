import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { computeStablePromotion, realGit } from '../../scripts/compute-stable-version.mjs';
import { gitCleanEnv } from '../../scripts/git-clean-env.mjs';

const BETA_TAG_RE = /^v\d+\.\d+\.\d+-beta\.\d+$/;
const STABLE_TAG_RE = /^v\d+\.\d+\.\d+$/;

const FAST_SOAK_SECONDS = 3600;
const BUG_LABEL = 'Bug';
const DEFAULT_LINK_REPO = 'inkeep/agents-private';
const LINEAR_API_URL = 'https://api.linear.app/graphql';
const ATTACHMENTS_FOR_URL_QUERY = `query AttachmentsForURL($url: String!) {
  attachmentsForURL(url: $url, first: 20) {
    nodes { issue { identifier labels(first: 50) { nodes { name } } } }
  }
}`;

export function parseBetaTags(rawTagOutput) {
  return rawTagOutput
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => BETA_TAG_RE.test(s));
}

function isFullyCut(meta) {
  const assets = Array.isArray(meta.assets) ? meta.assets : [];
  const hasDmg = assets.some((a) => typeof a.name === 'string' && a.name.endsWith('.dmg'));
  const hasManifest = assets.some((a) => typeof a.name === 'string' && a.name.endsWith('-mac.yml'));
  return meta.isDraft !== true && Boolean(meta.publishedAt) && hasDmg && hasManifest;
}

export function selectPromotion({
  betaTags,
  isAlreadyShipped,
  fetchReleaseMeta,
  soakSeconds,
  nowMs,
  qualifiesForFastTier = () => false,
  smokeBeta = null,
  log = () => {},
}) {
  const soakMs = soakSeconds * 1000;
  for (const beta of betaTags) {
    if (isAlreadyShipped(beta)) {
      return { kind: 'none' };
    }
    const meta = fetchReleaseMeta(beta);
    if (meta === null) continue;
    if (!isFullyCut(meta)) continue;
    const ageMs = nowMs - Date.parse(meta.publishedAt);
    if (!Number.isNaN(ageMs) && ageMs >= soakMs) {
      return { kind: 'select', target: beta, tier: 'soak' };
    }
    if (smokeBeta && qualifiesForFastTier(beta, meta)) {
      const verdict = evaluateSmoke(beta, smokeBeta, log);
      if (verdict === 'pass') {
        return { kind: 'select', target: beta, tier: 'fast' };
      }
      log(
        verdict === 'fail'
          ? `::warning::Fast tier REFUSED for ${beta}: its DMG failed the smoke subset. Falling back to the 24h tier.`
          : `::warning::Fast tier REFUSED for ${beta}: the DMG smoke hit an infrastructure error and never reached a verdict. Falling back to the 24h tier.`,
      );
    }
  }
  return { kind: 'none' };
}

function evaluateSmoke(beta, smokeBeta, log) {
  try {
    const verdict = smokeBeta(beta);
    return verdict === 'pass' || verdict === 'fail' ? verdict : 'error';
  } catch (err) {
    log(`::warning::DMG smoke threw for ${beta}: ${err?.message ?? String(err)}`);
    return 'error';
  }
}

export async function evaluateFastTier({
  candidate,
  computeDelta,
  resolveChangesetPrUrl,
  resolveIssuesForUrl,
  bugLabel = BUG_LABEL,
}) {
  const warnings = [];
  const verdict = (fields) => ({
    candidate: candidate || null,
    bump: null,
    deltaCount: null,
    bugLinked: false,
    linkedIssues: [],
    warnings,
    ...fields,
  });

  if (!candidate) return verdict({ qualifies: false, reason: 'no-fast-candidate' });

  let delta;
  try {
    delta = computeDelta(candidate);
  } catch (err) {
    warnings.push(`delta-error ${candidate}: ${err.message}`);
    return verdict({ qualifies: false, reason: 'delta-error' });
  }

  if (delta?.skip) return verdict({ qualifies: false, reason: 'delta-skipped' });
  if (delta?.bootstrap) return verdict({ qualifies: false, reason: 'delta-bootstrap' });

  const bump = delta?.bump ?? null;
  const deltaIds = Array.isArray(delta?.deltaIds) ? delta.deltaIds : [];
  const withDelta = (fields) => verdict({ bump, deltaCount: deltaIds.length, ...fields });

  if (bump !== 'patch') return withDelta({ qualifies: false, reason: 'bump-not-patch' });

  const wanted = String(bugLabel).toLowerCase();
  const linkedIssues = [];
  for (const id of deltaIds) {
    let url;
    try {
      url = resolveChangesetPrUrl(id);
    } catch (err) {
      warnings.push(`changeset-pr-error ${id}: ${err.message}`);
      continue;
    }
    if (!url) {
      warnings.push(`changeset-pr-unresolved ${id}`);
      continue;
    }

    let resolved;
    try {
      resolved = await resolveIssuesForUrl(url);
    } catch (err) {
      warnings.push(`issues-error ${url}: ${err.message}`);
      continue;
    }
    if (resolved?.unresolvable) {
      warnings.push(`issues-unresolvable ${url}: ${resolved.unresolvable}`);
      continue;
    }

    for (const issue of resolved?.issues ?? []) {
      const labels = Array.isArray(issue?.labels) ? issue.labels : [];
      if (labels.some((name) => String(name).toLowerCase() === wanted)) {
        linkedIssues.push(issue?.identifier || url);
      }
    }
  }

  if (linkedIssues.length === 0) return withDelta({ qualifies: false, reason: 'not-bug-linked' });
  return withDelta({
    qualifies: true,
    reason: 'patch-only-and-bug-linked',
    bugLinked: true,
    linkedIssues,
  });
}

export function resolveTier({ armed, verdict, standardTarget, fastTarget }) {
  const tier = armed && verdict?.qualifies === true ? 'fast' : 'standard';
  return { tier, target: standardTarget, candidate: tier === 'fast' ? fastTarget : '' };
}

function resolveLatestStableSha() {
  const out = execFileSync('git', ['tag', '--list', 'v*', '--sort=-version:refname'], {
    encoding: 'utf8',
    env: gitCleanEnv(),
  });
  for (const line of out.split('\n')) {
    const t = line.trim();
    if (STABLE_TAG_RE.test(t)) {
      return execFileSync('git', ['rev-parse', '--verify', `${t}^{commit}`], {
        encoding: 'utf8',
        env: gitCleanEnv(),
      }).trim();
    }
  }
  return '';
}

function makeRealIsAlreadyShipped(latestStableSha) {
  return (betaTag) => {
    if (!latestStableSha) return false;
    const betaSha = execFileSync('git', ['rev-parse', '--verify', `${betaTag}^{commit}`], {
      encoding: 'utf8',
      env: gitCleanEnv(),
    }).trim();
    const res = spawnSync('git', ['merge-base', '--is-ancestor', betaSha, latestStableSha], {
      encoding: 'utf8',
      env: gitCleanEnv(),
    });
    if (res.status === 0) return true;
    if (res.status === 1) return false;
    throw new Error(
      `git merge-base --is-ancestor ${betaSha} ${latestStableSha} failed (exit ${res.status}): ${String(res.stderr || '').trim()}`,
    );
  };
}

function realFetchReleaseMeta(tag) {
  try {
    const out = execFileSync(
      'gh',
      ['release', 'view', tag, '--json', 'isDraft,publishedAt,assets'],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    const j = JSON.parse(out);
    return { isDraft: j.isDraft, publishedAt: j.publishedAt || null, assets: j.assets || [] };
  } catch (err) {
    const stderr = String(err?.stderr || err?.message || '');
    if (/release not found|not found|HTTP 404|could not find/i.test(stderr)) {
      return null;
    }
    throw new Error(`gh release view ${tag} failed (non-404 infra error): ${stderr.trim()}`);
  }
}

export function makeResolveChangesetPrUrl(linkRepo) {
  return (changesetId) => {
    const subject = execFileSync(
      'git',
      ['log', '-1', '--diff-filter=A', '--format=%s', '--', `.changeset/${changesetId}.md`],
      { encoding: 'utf8', env: gitCleanEnv() },
    ).trim();
    const m = /\(#(\d+)\)$/.exec(subject);
    return m ? `https://github.com/${linkRepo}/pull/${m[1]}` : null;
  };
}

export function makeResolveIssuesForUrl(apiKey) {
  return async (url) => {
    if (!apiKey) return { unresolvable: 'no-linear-api-key' };

    const res = await fetch(LINEAR_API_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: apiKey },
      body: JSON.stringify({ query: ATTACHMENTS_FOR_URL_QUERY, variables: { url } }),
    });
    const body = await res.text();

    let payload;
    try {
      payload = JSON.parse(body);
    } catch {
      throw new Error(`Linear returned a non-JSON response (HTTP ${res.status}).`);
    }
    if (Array.isArray(payload?.errors) && payload.errors.length > 0) {
      const codes = payload.errors
        .map((e) => e?.extensions?.code)
        .filter(Boolean)
        .join(',');
      throw new Error(
        `Linear GraphQL error (HTTP ${res.status}${codes ? `, ${codes}` : ''}): ${payload.errors[0]?.message ?? 'unknown'}`,
      );
    }
    if (!res.ok) throw new Error(`Linear request failed (HTTP ${res.status}).`);

    const nodes = payload?.data?.attachmentsForURL?.nodes;
    if (!Array.isArray(nodes)) return { unresolvable: 'malformed-response' };

    const issues = [];
    for (const node of nodes) {
      const issue = node?.issue;
      if (!issue) continue;
      issues.push({
        identifier: issue.identifier ?? '',
        labels: (issue.labels?.nodes ?? [])
          .map((l) => l?.name)
          .filter((n) => typeof n === 'string'),
      });
    }
    return { issues };
  };
}

async function main() {
  const soakSeconds = Number(process.env.SOAK_SECONDS || '86400');
  const armed = process.env.FAST_TIER_ARMED === 'true';
  const rawTags = execFileSync('git', ['tag', '--list', 'v*-beta.*', '--sort=-version:refname'], {
    encoding: 'utf8',
    env: gitCleanEnv(),
  });
  const betaTags = parseBetaTags(rawTags);
  const latestStableSha = resolveLatestStableSha();
  const isAlreadyShipped = makeRealIsAlreadyShipped(latestStableSha);

  let result;
  try {
    result = selectPromotion({
      betaTags,
      isAlreadyShipped,
      fetchReleaseMeta: realFetchReleaseMeta,
      soakSeconds,
      nowMs: Date.now(),
    });
  } catch (err) {
    console.error(`::error::select-beta-to-promote: ${err.message}`);
    process.exit(1);
  }

  const standardTarget = result.kind === 'select' ? result.target : '';
  const selectionTier = result.kind === 'select' ? result.tier : '';
  if (standardTarget) {
    console.log(
      `::notice::Eligible: ${standardTarget} (unshipped + fully cut + soaked >= ${soakSeconds}s).`,
    );
  } else {
    console.log(
      'No-op: no beta is currently eligible (need unshipped + fully cut + soaked >= 24h).',
    );
  }

  let fastTarget = '';
  let verdict = {
    qualifies: false,
    reason: 'not-evaluated',
    candidate: null,
    bump: null,
    deltaCount: null,
    bugLinked: false,
    linkedIssues: [],
    warnings: [],
  };
  try {
    const fastCandidate = selectPromotion({
      betaTags,
      isAlreadyShipped,
      fetchReleaseMeta: realFetchReleaseMeta,
      soakSeconds: FAST_SOAK_SECONDS,
      nowMs: Date.now(),
    });
    fastTarget = fastCandidate.kind === 'select' ? fastCandidate.target : '';
    verdict = await evaluateFastTier({
      candidate: fastTarget,
      computeDelta: (betaTag) => computeStablePromotion(betaTag, realGit),
      resolveChangesetPrUrl: makeResolveChangesetPrUrl(process.env.LINK_REPO || DEFAULT_LINK_REPO),
      resolveIssuesForUrl: makeResolveIssuesForUrl(process.env.LINEAR_API_KEY),
    });
  } catch (err) {
    verdict = {
      ...verdict,
      reason: 'tier-evaluation-error',
      warnings: [`tier-evaluation-error: ${err.message}`],
    };
  }

  const { tier: soakTier, target, candidate: fastTierCandidate } = resolveTier({
    armed,
    verdict,
    standardTarget,
    fastTarget,
  });
  if (fastTierCandidate) {
    console.log(
      `::notice::Fast tier: nominating ${fastTierCandidate} for the DMG-smoke leg (patch-only + bug-linked, >=1h soak). ` +
        'Promotion happens only if the smoke passes; the 24h selection above is unaffected.',
    );
  }

  for (const warning of verdict.warnings) {
    console.log(`::warning::Soak-tier predicate degraded: ${warning}`);
  }
  console.log(
    `::notice::Soak tier: ${soakTier} (armed=${armed}; would-qualify=${verdict.qualifies}, reason=${verdict.reason}, candidate=${verdict.candidate || 'none'}, bump=${verdict.bump || 'none'}, delta=${verdict.deltaCount ?? 'none'}, bug-linked=${verdict.bugLinked}${verdict.linkedIssues.length > 0 ? ` [${verdict.linkedIssues.join(', ')}]` : ''}).`,
  );
  if (!armed) {
    console.log(
      `::notice::The fast soak tier is not armed; promotion continues to use the ${soakSeconds}s soak and the target is the 24h selection.`,
    );
  }

  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      [
        `target=${target}`,
        `tier=${selectionTier}`,
        `fast_tier_candidate=${fastTierCandidate}`,
        `soak_tier=${soakTier}`,
        `fast_armed=${armed}`,
        `fast_candidate=${verdict.candidate || ''}`,
        `fast_qualifies=${verdict.qualifies}`,
        `fast_reason=${verdict.reason}`,
        `fast_bump=${verdict.bump || ''}`,
        `fast_delta_count=${verdict.deltaCount ?? ''}`,
        `fast_bug_linked=${verdict.bugLinked}`,
        '',
      ].join('\n'),
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`::error::select-beta-to-promote: ${err.message}`);
    process.exit(1);
  });
}
