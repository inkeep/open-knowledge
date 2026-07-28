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

import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const BETA_TAG_RE = /^v\d+\.\d+\.\d+-beta\.\d+$/;
const STABLE_TAG_RE = /^v\d+\.\d+\.\d+$/;

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

function main() {
  const soakSeconds = Number(process.env.SOAK_SECONDS || '86400');
  const rawTags = execFileSync('git', ['tag', '--list', 'v*-beta.*', '--sort=-version:refname'], {
    encoding: 'utf8',
  });
  const betaTags = parseBetaTags(rawTags);
  const latestStableSha = resolveLatestStableSha();

  let result;
  try {
    result = selectPromotion({
      betaTags,
      isAlreadyShipped: makeRealIsAlreadyShipped(latestStableSha),
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

  let target = '';
  let tier = '';
  if (result.kind === 'select') {
    target = result.target;
    tier = result.tier;
    console.log(
      `::notice::Eligible: ${target} (unshipped + fully cut + soaked >= ${soakSeconds}s).`,
    );
  } else {
    console.log(
      'No-op: no beta is currently eligible (need unshipped + fully cut + soaked >= 24h).',
    );
  }

  if (process.env.GITHUB_OUTPUT) {
    // `fast_tier_candidate` is the seam the macOS smoke leg keys off. Nothing
    // populates it today: `main()` supplies no fast-tier predicate, so
    // selectPromotion never reports the fast tier and the leg never runs. That
    // is the whole of the build-but-do-not-arm posture — arming is a documented
    // operator step in RELEASES.md, not a side effect of merging this.
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `target=${target}\ntier=${tier}\nfast_tier_candidate=\n`,
    );
  }
}

// Run main() only as a CLI, not when imported by the test file. Portable across
// node (all ESM versions) and bun — import.meta.main is Node 24+ only.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
