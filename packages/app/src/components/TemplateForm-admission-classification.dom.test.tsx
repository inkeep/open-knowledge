import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { act, cleanup, renderHook } from '@testing-library/react';
import { toast } from 'sonner';
import { afterAll, afterEach, beforeAll, expect, test, vi } from 'vitest';
import type { BootedServer } from '../../../server/src/boot.ts';
import { bootCompositionRig, rawRequest } from '../../../server/src/composition-rig.test-helper.ts';
import { moveTemplate, saveTemplate } from '../lib/folder-config-api.ts';
import { composeDocBody, useTemplateForm } from './TemplateForm.tsx';

const nativeFetch = globalThis.fetch;
let root: string;
let server: BootedServer;
let sequence = 0;
const templatePath = (name: string) => join(root, 'templates', '.ok', 'templates', `${name}.md`);

async function post(method: 'PUT' | 'POST', input: object) {
  return rawRequest(server.port, '/api/template', {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
}

async function seed(name: string) {
  const result = await saveTemplate({
    folder: 'templates',
    name,
    frontmatter: { title: 'Existing' },
    body: 'Existing body.\n',
  });
  expect(result.ok, JSON.stringify(result)).toBe(true);
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'ok-template-admission-classification-'));
  mkdirSync(join(root, 'templates'));
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

test.each([
  {
    label: 'invalid frontmatter title',
    frontmatter: { title: '' },
    body: 'Safe.',
    code: 'TEMPLATE_TITLE_REQUIRED',
  },
  {
    label: 'unknown body substitution',
    frontmatter: { title: 'Existing' },
    body: '{{unrecognised}}',
    code: 'TEMPLATE_UNKNOWN_VARIABLE',
  },
])(
  'real template save $label keeps its previous title-only error',
  async ({ frontmatter, body, code }) => {
    const name = `classification-save-${++sequence}`;
    await seed(name);
    const original = readFileSync(templatePath(name));
    const input = { folder: 'templates', name, frontmatter, body };
    const response = await post('PUT', input);
    expect(response.status, response.body).toBe(400);
    const problem = JSON.parse(response.body) as { title: string; detail: string };
    expect(problem.detail).toBe(code);
    const result = await saveTemplate(input);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect.soft(result.error).toBe(problem.title);
    expect.soft(readFileSync(templatePath(name))).toEqual(original);
  },
);

test('real bodyless template rename to an existing target keeps its previous title-only error', async () => {
  const fromName = `classification-move-${++sequence}`;
  const toName = `${fromName}-occupied`;
  await seed(fromName);
  await seed(toName);
  const source = readFileSync(templatePath(fromName));
  const target = readFileSync(templatePath(toName));
  const input = { fromFolder: 'templates', fromName, toFolder: 'templates', toName };
  const response = await post('POST', input);
  expect(response.status, response.body).toBe(409);
  const problem = JSON.parse(response.body) as { title: string; detail: string };
  expect(problem.detail).toBe('TEMPLATE_EXISTS');
  const result = await moveTemplate(input);
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect.soft(result.error).toBe(problem.title);
  expect.soft(readFileSync(templatePath(fromName))).toEqual(source);
  expect.soft(readFileSync(templatePath(toName))).toEqual(target);
});

test.each(['markdown', 'property'] as const)(
  'actual form refusal qualifies full submitted body offsets for a control in %s with type and properties',
  async (location) => {
    const name = `classification-coordinate-${++sequence}`;
    await seed(name);
    const original = readFileSync(templatePath(name));
    const initialBody =
      location === 'markdown'
        ? '---\ntype: note\nstatus: draft\n---\n\nx😀\u0000private-tail'
        : '---\ntype: note\nstatus: x😀\u0000private-tail\n---\n\nSafe body.\n';
    const errorToast = vi.spyOn(toast, 'error');
    const committed = vi.fn();
    const { result } = renderHook(() =>
      useTemplateForm({
        mode: 'edit',
        folderPath: 'templates',
        scope: 'local',
        initial: { name, title: 'Existing', description: '', body: initialBody },
        onCommitted: committed,
      }),
    );
    const submittedBody = composeDocBody({
      type: result.current.type,
      properties: result.current.properties,
      markdown: result.current.body,
    });
    expect(submittedBody).toContain('type: note');
    expect(submittedBody).toContain('status: ');
    const response = await post('PUT', {
      folder: 'templates',
      name,
      frontmatter: { title: 'Existing' },
      body: submittedBody,
    });
    expect(response.status, response.body).toBe(400);
    const problem = JSON.parse(response.body) as { title: string; detail: string };
    expect(problem.detail).toContain('U+0000');
    expect(problem.detail).toMatch(
      new RegExp(`offset\\D*${submittedBody.indexOf('\u0000')}\\b`, 'i'),
    );
    expect.soft(problem.detail).toMatch(/full submitted (?:body|field|text)/i);
    expect.soft(problem.detail).toMatch(/including[^.]*frontmatter/i);
    await act(async () => result.current.submit());
    expect(errorToast).toHaveBeenCalledTimes(1);
    expect.soft(errorToast.mock.calls[0]?.[0]).toContain(problem.detail);
    expect.soft(committed).not.toHaveBeenCalled();
    expect.soft(readFileSync(templatePath(name))).toEqual(original);
    expect.soft(existsSync(templatePath(`${name}-renamed`))).toBe(false);
  },
);

test('real clean template body and property composition still saves byte-exact', async () => {
  const name = `classification-clean-${++sequence}`;
  const body = composeDocBody({
    type: 'note',
    properties: [{ id: 'status', key: 'status', value: 'draft' }],
    markdown: 'Exact\tline\r\nPrintable \\u0000 😀\u007f\u0080\u009f.\n',
  });
  const saved = await saveTemplate({
    folder: 'templates',
    name,
    frontmatter: { title: 'Clean' },
    body,
  });
  expect(saved.ok, JSON.stringify(saved)).toBe(true);
  const response = await rawRequest(
    server.port,
    `/api/template?${new URLSearchParams({ folder: 'templates', name })}`,
  );
  expect(response.status, response.body).toBe(200);
  expect(JSON.parse(response.body).template.body).toBe(body);
});
