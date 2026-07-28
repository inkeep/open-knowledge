// Beta-selection logic for the Select beta to promote workflow
// (.github/workflows/select-beta-to-promote.yml).
//
// This job does SELECTION ONLY: it finds the most-recently soak-proven beta
// (the newest beta that is fully cut AND online >= 24h) that has NOT already
// been shipped in the latest stable, then dispatches promote-stable.yml with it
// as an explicit beta_tag. It computes NO version — promote-stable.yml owns
// version determination (scripts/compute-stable-version.mjs), so manual and auto
// promotions share one source of version truth.
//
// Extracted here (rather than inline bash) so the release-critical selection is
// unit-tested under `vitest run --config vitest.scripts.config.ts` (the OK `check` gate),
// mirroring the scripts/compute-next-beta.mjs precedent. The pure core
// (parseBetaTags, selectPromotion) takes its git/GitHub boundary as injected
// dependencies so tests need no live repo or API.
//
// Fail-loud contract: selectPromotion treats ONLY a genuine "release not found"
// (404) as "this beta has no release yet" (skip to the next-older candidate).
// Any other fetch failure (auth, network, rate-limit) is an infrastructure
// error the caller must surface and retry, NEVER fold into a select/no-op
// decision — an unattended path that ships npm `latest` + a signed auto-update
// DMG must not mis-decide silently. fetchReleaseMeta signals this by returning
// null for 404 and throwing for everything else; selectPromotion lets the throw
// propagate so main() can exit non-zero.
//
// SOAK TIERS (currently LOG-ONLY — see below). Alongside the selection above the
// script answers a second, orthogonal question: would the cut in front of it
// qualify for a 1h, round-the-clock soak instead of the 24h weekday one?
// Qualifying means the changeset delta is BOTH patch-only AND carries a linked
// bug fix. patch-only alone is not selective — it describes roughly three
// quarters of recent stable transitions, so on its own it is a global soak
// reduction rather than a bug lane; the bug-linked conjunct is what makes it a
// lane.
//
// This is a DIFFERENT axis from the `tier` field selectPromotion returns. That
// one asks "may this UNDER-SOAKED beta promote early because its DMG smoked
// clean"; this one asks "how long should a cut have to soak at all". They never
// share a variable and are reported as separate outputs: `tier` and `soak_tier`.
//
// The soak tier is NOT armed. `FAST_TIER_ARMED` is a literal "false" in the
// workflow, so `resolveTier` can only ever return "standard" and the dispatched
// target is always the 24h selection. Everything here computes and logs the tier
// it WOULD choose. Arming is an owner decision and is documented, with its
// prerequisites, in RELEASES.md.

import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { computeStablePromotion, realGit } from '../../scripts/compute-stable-version.mjs';

const BETA_TAG_RE = /^v\d+\.\d+\.\d+-beta\.\d+$/;
const STABLE_TAG_RE = /^v\d+\.\d+\.\d+$/;

// Evaluation-only soak for the fast-tier candidate. It never reaches the
// promotion selection while the tier is unarmed.
const FAST_SOAK_SECONDS = 3600;
// Linear label that marks an issue as a bug fix.
const BUG_LABEL = 'Bug';
// Where a mirrored changeset's originating pull request lives. The mirror
// rewrites SHAs but preserves the squash subject, so the `(#N)` in that subject
// is a reference into the SOURCE monorepo, not into this repo.
const DEFAULT_LINK_REPO = 'inkeep/agents-private';
const LINEAR_API_URL = 'https://api.linear.app/graphql';
// One URL can carry more than one attachment, and attachments are the union of
// every carrier (branch, PR link, magic word, manual paste), which is why this
// asks the attachment graph rather than parsing branch names.
const ATTACHMENTS_FOR_URL_QUERY = `query AttachmentsForURL($url: String!) {
  attachmentsForURL(url: $url, first: 20) {
    nodes { issue { identifier labels(first: 50) { nodes { name } } } }
  }
}`;

// Filter raw `git tag` output to conforming beta tags, preserving input order.
// Ordering is git's job (`--sort=-version:refname`, newest first) — the same
// resolver promote-stable.yml / release.yml use; this only drops plain vX.Y.Z
// stable tags and any non-conforming ref.
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

// Walk betaTags newest -> oldest and return the selection decision:
//   { kind: "select", target, tier }  -> dispatch promote-stable for `target`
//   { kind: "none" }                  -> nothing eligible right now
// `tier` is "soak" for the 24h path and "fast" for a DMG-smoke-proven early
// promotion.
//
// Selects the NEWEST beta that is unshipped + fully cut + soaked >= soakSeconds.
// A fresher head that is under-soaked or not-yet-cut is skipped in favor of the
// previous soaked beta. The descent STOPS at the first already-shipped beta (its
// commit is contained in the latest stable, so everything older is too), so it
// never reaches back across a shipped boundary. Version is NOT computed here —
// promote-stable derives it from the changeset delta over the latest stable.
// Propagates any throw from fetchReleaseMeta (a non-404 infra error) instead of
// skipping the candidate.
//
// FAST TIER (FR5a), OFF BY DEFAULT. `qualifiesForFastTier` defaults to "nothing
// qualifies", which makes the under-soaked branch below fall through to the same
// `continue` this function has always used — so with no predicate supplied the
// decision is byte-for-byte what it is today and `smokeBeta` is never called.
// When a predicate IS supplied, an under-soaked candidate is promoted early only
// if its DMG smoke returns "pass". "fail" and "error" both refuse the fast tier
// and leave the 24h outcome exactly as it would have been, and neither ever
// fails the job — this evaluator must never block a release.
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
      // This beta's commit is already in the latest stable; every older beta is
      // too. Nothing newer than this is eligible below, so stop.
      return { kind: 'none' };
    }
    const meta = fetchReleaseMeta(beta); // null === 404 (no release yet); throws on infra error
    if (meta === null) continue;
    if (!isFullyCut(meta)) continue;
    const ageMs = nowMs - Date.parse(meta.publishedAt);
    if (!Number.isNaN(ageMs) && ageMs >= soakMs) {
      return { kind: 'select', target: beta, tier: 'soak' };
    }
    // Under-soaked (or unparseable publish date). The fast tier is the only way
    // this beta can be selected; everything below is inert unless armed.
    if (smokeBeta && qualifiesForFastTier(beta, meta)) {
      const verdict = evaluateSmoke(beta, smokeBeta, log);
      if (verdict === 'pass') {
        return { kind: 'select', target: beta, tier: 'fast' };
      }
      // Refuse the fast tier and keep descending, which is exactly what this
      // loop did before the fast tier existed.
      log(
        verdict === 'fail'
          ? `::warning::Fast tier REFUSED for ${beta}: its DMG failed the smoke subset. Falling back to the 24h tier.`
          : `::warning::Fast tier REFUSED for ${beta}: the DMG smoke hit an infrastructure error and never reached a verdict. Falling back to the 24h tier.`,
      );
    }
  }
  return { kind: 'none' };
}

// A smoke outcome can never fail this job (FR5a: the gate must never block a
// release), so a thrown smoke is folded into the `error` verdict rather than
// propagated. This is deliberately unlike fetchReleaseMeta, whose non-404
// throws MUST propagate — that one decides whether a beta is shippable at all.
function evaluateSmoke(beta, smokeBeta, log) {
  try {
    const verdict = smokeBeta(beta);
    return verdict === 'pass' || verdict === 'fail' ? verdict : 'error';
  } catch (err) {
    log(`::warning::DMG smoke threw for ${beta}: ${err?.message ?? String(err)}`);
    return 'error';
  }
}

// --- soak-tier predicate (evaluation only while unarmed) ---

// Does `candidate` qualify for the fast soak tier? Qualifying requires BOTH:
//   1. the changeset delta over the latest stable bumps only the patch level
//   2. at least one changeset in that delta traces to a bug-labelled issue
//
// The delta is not recomputed here. `computeDelta` is expected to be
// `computeStablePromotion`, the same function promote-stable derives the
// published version from, so "what is in this cut" has exactly one definition.
//
// Boundaries arrive as injected named seams so tests need no repo and no
// network:
//   computeDelta(betaTag)            -> the promotion decision for that tag
//   resolveChangesetPrUrl(id)        -> pull-request URL | null   (may throw)
//   resolveIssuesForUrl(url)         -> { issues } | { unresolvable } (may throw)
//
// DELIBERATE DEPARTURE FROM THIS FILE'S FAIL-LOUD CONTRACT. Everything above
// fails loud because a wrong SELECTION ships bad bytes. This predicate inverts
// that: it decides only how long a cut soaks, so its failure mode costs latency
// rather than correctness. Every failure, absence, or unresolvability therefore
// degrades to "does not qualify" — the slower, more conservative tier — with a
// warning recorded. Nothing here throws, and nothing here defaults to fast.
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

  // Nothing has cleared even the 1h soak, so there is no cut to classify.
  if (!candidate) return verdict({ qualifies: false, reason: 'no-fast-candidate' });

  let delta;
  try {
    delta = computeDelta(candidate);
  } catch (err) {
    warnings.push(`delta-error ${candidate}: ${err.message}`);
    return verdict({ qualifies: false, reason: 'delta-error' });
  }

  // Already shipped / empty delta, and first-stable bootstrap, are both real
  // answers rather than failures — neither describes a patch-only bug fix, and
  // neither carries a bump to test.
  if (delta?.skip) return verdict({ qualifies: false, reason: 'delta-skipped' });
  if (delta?.bootstrap) return verdict({ qualifies: false, reason: 'delta-bootstrap' });

  const bump = delta?.bump ?? null;
  const deltaIds = Array.isArray(delta?.deltaIds) ? delta.deltaIds : [];
  const withDelta = (fields) => verdict({ bump, deltaCount: deltaIds.length, ...fields });

  // Bump first, on purpose: it is local and free, while the bug-link hop costs
  // an API round trip per changeset. A non-patch delta can never qualify, so
  // there is nothing to learn from resolving its links.
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

    // One URL may resolve to several issues; any one of them carrying the label
    // makes the cut bug-linked.
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

// Fold the predicate verdict and the arming flag into the soak tier that governs
// this tick, and pick the target that tier implies.
//
// `armed` is the entire difference between "we computed a fast tier" and "a fast
// tier can shorten a real promotion". While it is false the fast branch is
// unreachable, so `target` is the 24h selection on every path — which is why the
// predicate can ship live without changing which betas promote, or when.
export function resolveTier({ armed, verdict, standardTarget, fastTarget }) {
  const tier = armed && verdict?.qualifies === true ? 'fast' : 'standard';
  return { tier, target: tier === 'fast' ? fastTarget : standardTarget };
}

// --- workflow-runtime wiring (real git / gh boundary) ---

// Newest plain vX.Y.Z stable tag's commit SHA ("" if no stable exists yet). The
// shipped boundary is defined by commit ancestry against this SHA rather than by
// a stable-tag-name existence check: under delta versioning a beta's name no
// longer maps 1:1 to a stable version, so "is this beta already released" is
// "is its commit contained in the latest stable".
function resolveLatestStableSha() {
  const out = execFileSync('git', ['tag', '--list', 'v*', '--sort=-version:refname'], {
    encoding: 'utf8',
  });
  for (const line of out.split('\n')) {
    const t = line.trim();
    if (STABLE_TAG_RE.test(t)) {
      return execFileSync('git', ['rev-parse', '--verify', `${t}^{commit}`], {
        encoding: 'utf8',
      }).trim();
    }
  }
  return '';
}

function makeRealIsAlreadyShipped(latestStableSha) {
  return (betaTag) => {
    if (!latestStableSha) return false; // no stable yet -> nothing is shipped
    const betaSha = execFileSync('git', ['rev-parse', '--verify', `${betaTag}^{commit}`], {
      encoding: 'utf8',
    }).trim();
    // Distinguish a clean "not an ancestor" (exit 1) from an infra failure (any
    // other non-zero), which must fail loud rather than read as "not shipped".
    const res = spawnSync('git', ['merge-base', '--is-ancestor', betaSha, latestStableSha], {
      encoding: 'utf8',
    });
    if (res.status === 0) return true;
    if (res.status === 1) return false;
    throw new Error(
      `git merge-base --is-ancestor ${betaSha} ${latestStableSha} failed (exit ${res.status}): ${String(res.stderr || '').trim()}`,
    );
  };
}

// Distinguish a genuine 404 ("release not found") from any other gh failure.
// gh writes the not-found message to stderr and exits non-zero; auth / network /
// rate-limit failures also exit non-zero but with a different message, so we
// string-match the 404 signature and rethrow everything else (fail loud).
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

// A changeset's originating pull request, via the commit that ADDED the file.
// Copybara rewrites SHAs but keeps the squash subject, and this repo's squash
// subjects end in `(#N)`, so the trailing reference survives the mirror. It is
// anchored to the end of the subject so a number quoted mid-title cannot
// outrank the real one. No `(#N)` (a hand-authored or imported commit) is a
// clean "no link", not an error.
export function makeResolveChangesetPrUrl(linkRepo) {
  return (changesetId) => {
    const subject = execFileSync(
      'git',
      ['log', '-1', '--diff-filter=A', '--format=%s', '--', `.changeset/${changesetId}.md`],
      { encoding: 'utf8' },
    ).trim();
    const m = /\(#(\d+)\)$/.exec(subject);
    return m ? `https://github.com/${linkRepo}/pull/${m[1]}` : null;
  };
}

// Issues attached to a pull-request URL in Linear.
//
// Header is the raw key: `Bearer` is the OAuth form and is rejected for a
// personal API key. Rate limiting arrives as an HTTP 400 carrying
// `errors[].extensions.code === "RATELIMITED"` rather than a 429, so the GraphQL
// error array is inspected before the status code.
//
// Returns `{ unresolvable }` for the states that are simply "we cannot answer"
// (no key configured, a response we do not recognize) and throws for transport
// and API failures. The caller degrades on both; the split exists so the two
// read differently in the log.
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
    // Fail loud: an infra error means we cannot trust the decision. Exit
    // non-zero so the failure surfaces in the Actions UI and the next tick
    // retries once the issue clears — never a silent skip/no-op.
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

  // Soak-tier evaluation runs on EVERY tick, including outside business hours,
  // so the decision and its inputs are observable before anyone relies on them.
  // The whole block is guarded: the selection above is already final, and a tier
  // that cannot be computed must cost latency, never the tick.
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

  const { tier: soakTier, target } = resolveTier({ armed, verdict, standardTarget, fastTarget });

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
    // `fast_tier_candidate` is the seam the macOS smoke leg keys off. Nothing
    // populates it: it is written empty here and the soak-tier predicate never
    // feeds it, because the two answer different questions (may an under-soaked
    // beta promote early on a clean DMG smoke, versus how long should a cut soak
    // at all). Wiring them together is a separate, deliberate step.
    //
    // Every other value is a validated tag, a fixed reason keyword, a boolean,
    // or a number, so none of them can break the key=value framing. Warnings are
    // deliberately log-only — they carry API error text.
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      [
        `target=${target}`,
        `tier=${selectionTier}`,
        'fast_tier_candidate=',
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

// Run main() only as a CLI, not when imported by the test file. Portable across
// node (all ESM versions) and bun — import.meta.main is Node 24+ only.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    // main() is async only because the bug-link hop is; the fail-loud contract
    // is unchanged, so a rejection still exits non-zero and retries next tick.
    console.error(`::error::select-beta-to-promote: ${err.message}`);
    process.exit(1);
  });
}
