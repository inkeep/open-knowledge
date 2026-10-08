import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { act, cleanup, renderHook } from '@testing-library/react';
import { toast } from 'sonner';
import { afterAll, afterEach, beforeAll, expect, test, vi } from 'vitest';
import type { BootedServer } from '../../../server/src/boot.ts';
import { bootCompositionRig, rawRequest } from '../../../server/src/composition-rig.test-helper.ts';
import { moveTemplate, saveTemplate } from '../lib/folder-config-api.ts';
import { useTemplateForm } from './TemplateForm.tsx';

const body = 'private-prefix x😀\u0000private-tail';
const nativeFetch = globalThis.fetch;
let root: string;
let server: BootedServer;
let sequence = 0;

function templatePath(name: string) {
  return join(root, 'templates', '.ok', 'templates', `${name}.md`);
}

async function refusal(method: 'PUT' | 'POST', name: string, toName: string) {
  const input =
    method === 'PUT'
      ? { folder: 'templates', name, frontmatter: { title: 'Existing' }, body }
      : {
          fromFolder: 'templates',
          fromName: name,
          toFolder: 'templates',
          toName,
          frontmatter: { title: 'Existing' },
          body,
        };
  const response = await rawRequest(server.port, '/api/template', {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  expect(response.status, response.body).toBe(400);
  const problem = JSON.parse(response.body) as { title: string; detail: string };
  expect(problem.detail).toContain('U+0000');
  expect(problem.detail).toMatch(/body/i);
  expect(problem.detail).toMatch(/UTF-?16/i);
  expect(problem.detail).toMatch(new RegExp(`offset\\D*${'private-prefix x😀'.length}\\b`, 'i'));
  expect(problem.detail).not.toContain('private-prefix');
  expect(problem.detail).not.toContain('private-tail');
  return problem;
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'ok-template-renderer-detail-'));
  mkdirSync(join(root, 'templates', '.ok', 'templates'), { recursive: true });
  server = await bootCompositionRig(root);
  await server.ready;
  vi.stubGlobal('fetch', ((input: string | URL | Request, init?: RequestInit) =>
    nativeFetch(
      typeof input === 'string' ? new URL(input, `http://127.0.0.1:${server.port}`) : input,
      init,
    )) satisfies typeof fetch);
}, 60_000);

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await server?.destroy();
  rmSync(root, { recursive: true, force: true });
});

test.each(['PUT', 'POST'] as const)(
  'actual template API %s caller preserves the real HTTP admission detail',
  async (method) => {
    const name = `api-detail-${++sequence}`;
    const toName = `${name}-renamed`;
    const original = '---\ntitle: Existing\n---\nExisting body.\n';
    writeFileSync(templatePath(name), original);
    const problem = await refusal(method, name, toName);
    const result =
      method === 'PUT'
        ? await saveTemplate({
            folder: 'templates',
            name,
            frontmatter: { title: 'Existing' },
            body,
          })
        : await moveTemplate({
            fromFolder: 'templates',
            fromName: name,
            toFolder: 'templates',
            toName,
            frontmatter: { title: 'Existing' },
            body,
          });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect.soft(result.error).toContain(problem.detail);
    expect.soft(readFileSync(templatePath(name), 'utf8')).toBe(original);
    expect.soft(existsSync(templatePath(toName))).toBe(false);
  },
);

test.each([false, true])(
  'actual template form submit shows the actionable real HTTP detail (rename=%s)',
  async (rename) => {
    const name = `form-detail-${++sequence}`;
    const toName = `${name}-renamed`;
    const original = `---\ntitle: Existing\n---\n${body}`;
    writeFileSync(templatePath(name), original);
    const problem = await refusal(rename ? 'POST' : 'PUT', name, toName);
    const errorToast = vi.spyOn(toast, 'error');
    const committed = vi.fn();
    const { result } = renderHook(() =>
      useTemplateForm({
        mode: 'edit',
        folderPath: 'templates',
        scope: 'local',
        initial: { name, title: 'Existing', description: '', body },
        onCommitted: committed,
      }),
    );
    if (rename) await act(async () => result.current.setSlug(toName));
    await act(async () => result.current.submit());
    expect(errorToast).toHaveBeenCalledTimes(1);
    expect.soft(errorToast.mock.calls[0]?.[0]).toContain(problem.detail);
    expect.soft(committed).not.toHaveBeenCalled();
    expect.soft(result.current.isSaving).toBe(false);
    expect.soft(result.current.canSubmit).toBe(true);
    expect.soft(readFileSync(templatePath(name), 'utf8')).toBe(original);
    expect.soft(existsSync(templatePath(toName))).toBe(false);
  },
);

test('actual template callers still save and rename admitted content byte-exact', async () => {
  const name = `safe-detail-${++sequence}`;
  const toName = `${name}-renamed`;
  const allowed = 'Exact\tline\r\nPrintable \\u0000 😀\u007f\u0080\u009f.\n';
  const saved = await saveTemplate({
    folder: 'templates',
    name,
    frontmatter: { title: 'Safe' },
    body: allowed,
  });
  expect(saved.ok, JSON.stringify(saved)).toBe(true);
  const moved = await moveTemplate({
    fromFolder: 'templates',
    fromName: name,
    toFolder: 'templates',
    toName,
    frontmatter: { title: 'Moved' },
    body: allowed,
  });
  expect(moved.ok, JSON.stringify(moved)).toBe(true);
  expect(existsSync(templatePath(name))).toBe(false);
  expect(readFileSync(templatePath(toName), 'utf8')).toContain(allowed);
  const response = await rawRequest(
    server.port,
    `/api/template?${new URLSearchParams({ folder: 'templates', name: toName })}`,
  );
  expect(response.status, response.body).toBe(200);
  expect(JSON.parse(response.body).template.body).toBe(allowed);
});
