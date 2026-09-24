/* biome-ignore-all lint/suspicious/noUndeclaredEnvVars: GitHub Actions invokes this entrypoint directly, outside Turbo. */
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const DESKTOP_IDENTITY_SPLIT_COMMIT = '15cd5fd9c2644d9af05609d501a5f068a1da106c';

export function candidateIdentity(comparisonStatus) {
  if (comparisonStatus === 'behind') return 'legacy';
  if (comparisonStatus === 'ahead' || comparisonStatus === 'identical') return 'beta';
  throw new Error(`Cannot establish candidate product identity: ${comparisonStatus}`);
}

export function selectDmgAsset(assets, identity) {
  const names = assets
    .map((asset) => asset.name)
    .filter((name) => /^OpenKnowledge(?:-Beta)?-(?:arm64|x64|universal)\.dmg$/.test(name));
  if (names.length !== 1) return null;
  if (identity === 'beta' && names[0].startsWith('OpenKnowledge-Beta-')) return names[0];
  if (identity === 'legacy' && !names[0].startsWith('OpenKnowledge-Beta-')) return names[0];
  return null;
}

function ghText(args, timeout = 30_000) {
  return execFileSync('gh', args, { encoding: 'utf8', timeout });
}

export function downloadCandidateDmg({ candidate, dir, gh = ghText }) {
  if (!/^v\d+\.\d+\.\d+-beta\.\d+$/.test(candidate ?? '')) {
    throw new Error('A beta CANDIDATE tag is required');
  }
  const meta = JSON.parse(gh(['release', 'view', candidate, '--json', 'assets']));
  const comparison = JSON.parse(
    gh([
      'api',
      `repos/{owner}/{repo}/compare/${DESKTOP_IDENTITY_SPLIT_COMMIT}...${candidate}?per_page=1`,
      '--jq',
      '{status}',
    ]),
  );
  const identity = candidateIdentity(comparison.status);
  const asset = selectDmgAsset(meta.assets, identity);
  if (asset === null) throw new Error(`No unique ${identity} DMG in ${candidate}`);
  mkdirSync(dir, { recursive: true });
  gh(['release', 'download', candidate, '--pattern', asset, '--dir', dir], 300_000);
  return join(dir, asset);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dmgPath = downloadCandidateDmg({
    candidate: process.env.CANDIDATE,
    dir: join(process.env.RUNNER_TEMP, 'fast-tier-dmg'),
  });
  appendFileSync(process.env.GITHUB_OUTPUT, `dmg_path=${dmgPath}\n`);
}
