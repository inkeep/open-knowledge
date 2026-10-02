import { createHash } from 'node:crypto';
import { appendFileSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

export const NATIVE_CONFIG_DIR = 'packages/native-config';
export const CLI_NATIVE_DIR = 'packages/cli/dist/native';
export const PLATFORMS = { mac: 'darwin', windows: 'win32', linux: 'linux' };
export const RECOVERY_SECTION = 'Native addon staging';

const PLATFORM_NAMES = Object.keys(PLATFORMS);

export function parsePlatforms(list) {
  if (typeof list !== 'string' || list === '') {
    throw new Error(
      `platforms needs a comma-separated list of ${PLATFORM_NAMES.join(', ')}, or none`,
    );
  }
  if (list === 'none') return [];
  const names = [...new Set(list.split(',').map((name) => name.trim()))];
  const unknown = names.filter((name) => !Object.hasOwn(PLATFORMS, name));
  if (unknown.length > 0) {
    throw new Error(
      `unknown platform ${unknown.join(', ')}; the platforms are ${PLATFORM_NAMES.join(', ')}`,
    );
  }
  return names;
}

function declaredTargets(napi, parseTriple) {
  const { binaryName, targets } = napi ?? {};
  if (typeof binaryName !== 'string' || !Array.isArray(targets) || targets.length === 0) {
    throw new Error(`${NATIVE_CONFIG_DIR}/package.json declares no napi binaryName and targets`);
  }
  return targets.map((target) => {
    const { platform, arch, platformArchABI } = parseTriple(target);
    const owner = PLATFORM_NAMES.find((name) => PLATFORMS[name] === platform);
    if (!owner) {
      throw new Error(
        `napi target ${target} is for ${platform}, which no release platform (${PLATFORM_NAMES.join(', ')}) packages`,
      );
    }
    return { platform: owner, os: platform, arch, name: `${binaryName}.${platformArchABI}.node` };
  });
}

export function expectedBinaries({ napi, parseTriple, mode, platforms = [], host = process }) {
  if (mode !== 'host' && mode !== 'platforms') {
    throw new Error(`mode must be one of host, platforms, not ${mode}`);
  }
  const declared = declaredTargets(napi, parseTriple);
  const bare =
    mode === 'platforms'
      ? platforms.filter((name) => !declared.some(({ platform }) => platform === name))
      : [];
  if (bare.length > 0) {
    throw new Error(
      `no declared napi target in ${NATIVE_CONFIG_DIR}/package.json is for ${bare.join(', ')}`,
    );
  }
  const chosen =
    mode === 'platforms'
      ? declared.filter(({ platform }) => platforms.includes(platform))
      : declared.filter(({ os, arch }) => os === host.platform && arch === host.arch);
  if (mode === 'host' && chosen.length !== 1) {
    throw new Error(
      `host mode needs exactly one declared napi target for ${host.platform}-${host.arch}; found ${chosen.length}`,
    );
  }
  return chosen.map(({ name }) => name).sort();
}

function readNapi(root) {
  return JSON.parse(readFileSync(join(root, NATIVE_CONFIG_DIR, 'package.json'), 'utf8')).napi;
}

function inventory(root, dir) {
  const files = readdirSync(join(root, dir)).filter((name) => name.endsWith('.node'));
  return new Map(
    files.sort().map((name) => {
      const bytes = readFileSync(join(root, dir, name));
      return [
        name,
        { size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') },
      ];
    }),
  );
}

export function assertNativeSet({ root, mode, platforms = [], parseTriple, host = process }) {
  const lines = [];
  const errors = [];
  let expected;
  let allowed;
  try {
    const napi = readNapi(root);
    expected = expectedBinaries({ napi, parseTriple, mode, platforms, host });
    allowed =
      mode === 'host' ? expected : declaredTargets(napi, parseTriple).map(({ name }) => name);
  } catch (error) {
    return { lines, errors: [`cannot derive the expected native set: ${error.message}`] };
  }
  const stray = mode === 'host' ? 'is not a declared host target' : 'is not a declared napi target';
  const sets = new Map();
  for (const dir of [NATIVE_CONFIG_DIR, CLI_NATIVE_DIR]) {
    try {
      sets.set(dir, inventory(root, dir));
    } catch (error) {
      errors.push(`cannot read ${dir}: ${error.message}`);
      continue;
    }
    const found = sets.get(dir);
    for (const [name, { size, sha256 }] of found)
      lines.push(`native-set ${dir}/${name} ${size} ${sha256}`);
    for (const name of expected.filter((name) => !found.has(name)))
      errors.push(`${dir}/${name} is missing`);
    for (const name of [...found.keys()].filter((name) => !allowed.includes(name)))
      errors.push(`${dir}/${name} ${stray}`);
    for (const name of expected.filter((name) => found.get(name)?.size === 0))
      errors.push(`${dir}/${name} is empty`);
  }
  const source = sets.get(NATIVE_CONFIG_DIR);
  const shipped = sets.get(CLI_NATIVE_DIR);
  if (source && shipped) {
    for (const [name, { sha256 }] of shipped) {
      if (source.has(name) && source.get(name).sha256 !== sha256) {
        errors.push(`${CLI_NATIVE_DIR}/${name} differs from ${NATIVE_CONFIG_DIR}/${name}`);
      }
    }
  }
  return { lines, errors, expected };
}

export function stagingVerdict({ root, serves, requires, parseTriple }) {
  const napi = readNapi(root);
  const staged = inventory(root, NATIVE_CONFIG_DIR);
  const judged = new Map(
    [...new Set([...serves, ...requires])].map((platform) => [
      platform,
      expectedBinaries({ napi, parseTriple, mode: 'platforms', platforms: [platform] }),
    ]),
  );
  const packaged = [];
  const refusals = [];
  const drops = [];
  for (const platform of serves) {
    const missing = judged.get(platform).filter((name) => !(staged.get(name)?.size > 0));
    if (missing.length === 0) packaged.push(platform);
    else if (requires.includes(platform)) refusals.push({ platform, missing });
    else drops.push({ platform, missing });
  }
  return { packaged: refusals.length > 0 ? [] : packaged, refusals, drops };
}

async function loadParseTriple(root) {
  const requireFromNativeConfig = createRequire(join(root, NATIVE_CONFIG_DIR, 'package.json'));
  const { parseTriple } = await import(
    pathToFileURL(requireFromNativeConfig.resolve('@napi-rs/cli')).href
  );
  if (typeof parseTriple !== 'function') throw new Error('@napi-rs/cli exports no parseTriple');
  return parseTriple;
}

function judgeStaging(args, root, parseTriple) {
  const { values } = parseArgs({
    args,
    options: {
      serves: { type: 'string' },
      requires: { type: 'string' },
      reason: { type: 'string', default: '' },
      recovery: { type: 'string', default: '' },
    },
  });
  const serves = parsePlatforms(values.serves);
  const requires = parsePlatforms(values.requires);
  const { packaged, refusals, drops } = stagingVerdict({ root, serves, requires, parseTriple });
  const why = values.reason ? ` (${values.reason})` : '';
  for (const { platform, missing } of drops) {
    console.log(
      `::warning::DEGRADED CUT: ${platform} is not a required platform, and its staged native-config set is missing ${missing.join(', ')}${why}, so ${platform} is not packaged or shipped this cut. Its clients 404 this cut's channel manifest and stay on their current version.`,
    );
    if (process.env.GITHUB_STEP_SUMMARY) {
      appendFileSync(
        process.env.GITHUB_STEP_SUMMARY,
        `### ⚠️ Degraded cut: ${platform} not packaged (staged native-config set is missing ${missing.join(', ')})\n`,
      );
    }
  }
  for (const { platform, missing } of refusals) {
    console.log(
      `::error::native-set: ${platform} is a required platform, and its staged native-config set is missing ${missing.join(', ')}${why}. ${values.recovery}`.trimEnd(),
    );
  }
  if (refusals.length > 0) return 1;
  const list = packaged.length > 0 ? packaged.join(',') : 'none';
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `platforms=${list}\n`);
  console.log(`native-set staged: packaging ${list}`);
  return 0;
}

export async function main(argv = process.argv.slice(2), root = process.cwd()) {
  const [mode, ...rest] = argv;
  let parseTriple;
  try {
    parseTriple = await loadParseTriple(root);
  } catch (error) {
    console.log(
      `::error::cannot load napi's target parser from ${NATIVE_CONFIG_DIR}: ${error.message}`,
    );
    return 1;
  }
  try {
    if (mode === 'staged') return judgeStaging(rest, root, parseTriple);
    if (mode !== 'host' && mode !== 'platforms') {
      throw new Error(`mode must be one of host, platforms, staged, not ${mode}`);
    }
    const platforms = mode === 'platforms' ? parsePlatforms(rest[0]) : [];
    const label = mode === 'host' ? 'host' : platforms.join(', ') || 'no platform';
    const { lines, errors, expected } = assertNativeSet({ root, mode, platforms, parseTriple });
    for (const line of lines) console.log(line);
    if (errors.length > 0) {
      for (const error of errors) console.log(`::error::native-set: ${error}`);
      console.log(
        `::error::native-set: the built binaries are not the declared set for ${label}. If a staged binary is missing, re-run native-config-prebuild.yml on an ancestor of this commit, then resume per RELEASES.md '${RECOVERY_SECTION}'.`,
      );
      return 1;
    }
    console.log(
      `native-set ok: ${expected.length} binaries for ${label} present, non-empty and identical in ${NATIVE_CONFIG_DIR} and ${CLI_NATIVE_DIR}`,
    );
    return 0;
  } catch (error) {
    console.log(`::error::native-set: ${error.message}`);
    return 1;
  }
}

if (import.meta.main) {
  process.exitCode = await main();
}
