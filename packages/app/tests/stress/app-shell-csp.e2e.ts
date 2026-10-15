import { randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import { type ApiHelpers, expect, test } from './_helpers';

test.use({ workerServerEnv: { OK_TEST_PRODUCTION_SHELL: '1' } });

type PolicyViolationLog = Window & { shellPolicyViolations?: string[] };

async function openSeededDoc(page: Page, api: ApiHelpers, heading: string, body = '') {
  const docName = `shell-csp-${randomUUID().slice(0, 8)}`;
  await api.createPage(`${docName}.md`);
  await api.replaceDoc(docName, `# ${heading}\n\n${body}`);
  await page.goto(`/#/${docName}`);
  await expect(page.getByRole('heading', { name: heading })).toBeVisible();
}

test('every shell document sirv serves carries the policy of that document', async ({ page }) => {
  const policyOf = async (path: string) => {
    const response = await page.request.get(path);
    expect(response.status(), path).toBe(200);
    return response.headers()['content-security-policy'] ?? '';
  };

  const shellPolicy = await policyOf('/');
  expect(shellPolicy).toContain("script-src 'self'");
  expect(shellPolicy).toContain("object-src 'none'");
  expect(shellPolicy).not.toContain("'unsafe-inline'");
  for (const fallbackPath of ['/@x.y', '/notes.v2/', '/x@y.html']) {
    expect(await policyOf(fallbackPath), fallbackPath).toBe(shellPolicy);
  }

  const uninstallPolicy = await policyOf('/uninstall.html');
  expect(uninstallPolicy).toContain("script-src 'self'");
  expect(uninstallPolicy).not.toBe(shellPolicy);
  expect(await policyOf('/uninstall')).toBe(uninstallPolicy);

  const framePolicy = "sandbox allow-scripts; frame-ancestors 'self'";
  expect(await policyOf('/assets/preview-frame.html')).toBe(framePolicy);
  expect(await policyOf('/assets/preview-frame')).toBe(framePolicy);
});

test('the web shell refuses an injected inline event handler', async ({ page, api }) => {
  await openSeededDoc(page, api, 'Shell policy');

  const outcome = await page.evaluate(
    () =>
      new Promise<{ ran: boolean; directive: string }>((resolve) => {
        const probe = window as Window & { injectedHandlerRan?: boolean };
        const timer = setTimeout(
          () => resolve({ ran: Boolean(probe.injectedHandlerRan), directive: '' }),
          5_000,
        );
        document.addEventListener(
          'securitypolicyviolation',
          (event) => {
            clearTimeout(timer);
            resolve({
              ran: Boolean(probe.injectedHandlerRan),
              directive: event.effectiveDirective,
            });
          },
          { once: true },
        );
        const host = document.createElement('div');
        host.innerHTML = '<img src="data:," alt="" onerror="window.injectedHandlerRan = true">';
        document.body.append(host);
      }),
  );

  expect(outcome.ran).toBe(false);
  expect(outcome.directive).toMatch(/^script-src/);
});

test('the editor, Mermaid and html previews keep working under the shell policy', async ({
  page,
  api,
}) => {
  await page.addInitScript(() => {
    const violations: string[] = [];
    (window as PolicyViolationLog).shellPolicyViolations = violations;
    document.addEventListener('securitypolicyviolation', (event) => {
      violations.push(`${event.effectiveDirective} ${event.blockedURI}`);
    });
  });

  await openSeededDoc(
    page,
    api,
    'Under policy',
    [
      '```mermaid',
      'flowchart TD',
      '  A[Start] --> B[Finish]',
      '```',
      '',
      '```html preview',
      '<div id="probe">before</div>',
      "<script>document.getElementById('probe').textContent = 'ran';</script>",
      '```',
      '',
    ].join('\n'),
  );

  await expect(
    page.locator('[data-component-type="mermaid"].mermaid-ready .nodeLabel', { hasText: 'Start' }),
  ).toBeVisible();
  await expect(page.frameLocator('iframe[title="HTML preview"]').locator('#probe')).toHaveText(
    'ran',
  );
  expect(
    await page.evaluate(() => (window as PolicyViolationLog).shellPolicyViolations ?? []),
  ).toEqual([]);
});
