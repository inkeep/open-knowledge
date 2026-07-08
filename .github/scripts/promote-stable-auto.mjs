// Beta-selection logic for the Auto-promote stable workflow
// (.github/workflows/promote-stable-auto.yml).
//
// Extracted here (rather than inline bash) so the release-critical decision —
// which beta, if any, to promote to stable — is unit-tested under
// `bun test --cwd .github/scripts` (the OK `check` gate), mirroring the
// scripts/compute-next-beta.mjs precedent. The pure core (deriveStableTag,
// parseBetaTags, selectPromotion) takes its git/GitHub boundary as injected
// dependencies so tests need no live repo or API.
//
// Fail-loud contract: selectPromotion treats ONLY a genuine "release not found"
// (404) as "this beta has no release yet" (skip to the next-older candidate).
// Any other fetch failure (auth, network, rate-limit) is an infrastructure
// error the caller must surface and retry, NEVER fold into a promote/no-op
// decision — an unattended path that ships npm `latest` + a signed auto-update
// DMG must not mis-decide silently. fetchReleaseMeta signals this by returning
// null for 404 and throwing for everything else; selectPromotion lets the throw
// propagate so main() can exit non-zero.

import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const BETA_TAG_RE = /^v\d+\.\d+\.\d+-beta\.\d+$/;

// v0.10.0-beta.10 -> v0.10.0. The digit-run match keeps double-digit beta
// numbers intact (the derived stable tag drops the whole -beta.N suffix).
export function deriveStableTag(betaTag) {
  const m = /^(v\d+\.\d+\.\d+)-beta\.\d+$/.exec(betaTag);
  if (!m) throw new Error(`not a vX.Y.Z-beta.N tag: ${betaTag}`);
  return m[1];
}

// Filter raw `git tag` output to conforming beta tags, preserving input order.
// Ordering is git's job (`--sort=-version:refname`, newest first) — the same
// resolver promote-stable.yml / release.yml use; this only drops plain vX.Y.Z
// stable tags and any non-conforming ref.
export function parseBetaTags(rawTagOutput) {
  return rawTagOutput
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => BETA_TAG_RE.test(s));
}

function isFullyCut(meta) {
  const assets = Array.isArray(meta.assets) ? meta.assets : [];
  const hasDmg = assets.some((a) => typeof a.name === "string" && a.name.endsWith(".dmg"));
  const hasManifest = assets.some((a) => typeof a.name === "string" && a.name.endsWith("-mac.yml"));
  return meta.isDraft !== true && Boolean(meta.publishedAt) && hasDmg && hasManifest;
}

// Walk betaTags newest -> oldest and return the promotion decision:
//   { kind: "select", target, stableTag }      -> dispatch promote-stable for `target`
//   { kind: "stop-promoted", beta, stableTag }  -> newest unpromoted candidate is already
//                                                  promoted; descent stops (no target)
//   { kind: "none" }                            -> nothing eligible right now
// Selects the LATEST beta that is unpromoted + fully cut + soaked >= soakSeconds.
// A fresher, under-soaked/not-yet-cut head is skipped in favor of the previous
// eligible beta; the descent STOPS at the first already-promoted beta so it
// never reaches back across a promoted cycle boundary. Propagates any throw from
// fetchReleaseMeta (a non-404 infra error) instead of skipping the candidate.
export function selectPromotion({ betaTags, tagExists, fetchReleaseMeta, soakSeconds, nowMs }) {
  const soakMs = soakSeconds * 1000;
  for (const beta of betaTags) {
    const stableTag = deriveStableTag(beta);
    if (tagExists(stableTag)) {
      return { kind: "stop-promoted", beta, stableTag };
    }
    const meta = fetchReleaseMeta(beta); // null === 404 (no release yet); throws on infra error
    if (meta === null) continue;
    if (!isFullyCut(meta)) continue;
    const ageMs = nowMs - Date.parse(meta.publishedAt);
    if (Number.isNaN(ageMs) || ageMs < soakMs) continue;
    return { kind: "select", target: beta, stableTag };
  }
  return { kind: "none" };
}

// --- workflow-runtime wiring (real git / gh boundary) ---

function realTagExists(tag) {
  try {
    execFileSync("git", ["rev-parse", "--verify", "--quiet", `refs/tags/${tag}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

// Distinguish a genuine 404 ("release not found") from any other gh failure.
// gh writes the not-found message to stderr and exits non-zero; auth / network /
// rate-limit failures also exit non-zero but with a different message, so we
// string-match the 404 signature and rethrow everything else (fail loud).
function realFetchReleaseMeta(tag) {
  try {
    const out = execFileSync("gh", ["release", "view", tag, "--json", "isDraft,publishedAt,assets"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const j = JSON.parse(out);
    return { isDraft: j.isDraft, publishedAt: j.publishedAt || null, assets: j.assets || [] };
  } catch (err) {
    const stderr = String(err?.stderr || err?.message || "");
    if (/release not found|not found|HTTP 404|could not find/i.test(stderr)) {
      return null;
    }
    throw new Error(`gh release view ${tag} failed (non-404 infra error): ${stderr.trim()}`);
  }
}

function main() {
  const soakSeconds = Number(process.env.SOAK_SECONDS || "86400");
  const rawTags = execFileSync("git", ["tag", "--list", "v*-beta.*", "--sort=-version:refname"], {
    encoding: "utf8",
  });
  const betaTags = parseBetaTags(rawTags);

  let result;
  try {
    result = selectPromotion({
      betaTags,
      tagExists: realTagExists,
      fetchReleaseMeta: realFetchReleaseMeta,
      soakSeconds,
      nowMs: Date.now(),
    });
  } catch (err) {
    // Fail loud: an infra error means we cannot trust the decision. Exit
    // non-zero so the failure surfaces in the Actions UI and the next tick
    // retries once the issue clears — never a silent skip/no-op.
    console.error(`::error::promote-stable-auto: ${err.message}`);
    process.exit(1);
  }

  let target = "";
  let stable = "";
  if (result.kind === "select") {
    target = result.target;
    stable = result.stableTag;
    console.log(`::notice::Eligible: ${target} (unpromoted + fully cut + soaked >= ${soakSeconds}s) -> ${stable}`);
  } else if (result.kind === "stop-promoted") {
    console.log(`No-op: newest candidate ${result.beta} is already promoted to ${result.stableTag}.`);
  } else {
    console.log("No-op: no beta is currently eligible (need unpromoted + fully cut + soaked >= 24h).");
  }

  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `target=${target}\nstable=${stable}\n`);
  }
}

// Run main() only as a CLI, not when imported by the test file. Portable across
// node (all ESM versions) and bun — import.meta.main is Node 24+ only.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
