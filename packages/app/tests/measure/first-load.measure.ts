import { writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import {
  type Browser,
  type BrowserContext,
  expect,
  type Locator,
  type Page,
} from '@playwright/test';
import { test as base } from '../stress/_helpers/fixtures.ts';

interface FirstLoadMarks {
  workerSetupStart?: number;
  contextStart?: number;
  pageReady?: number;
  navigationStart?: number;
  navigationSettled?: number;
  navigationOk?: boolean;
  treeVisibleAt?: number;
  treeVisible?: boolean;
  workerSetupEnd?: number;
}

interface RendererRequest {
  url: string;
  resourceType: string;
  at: number;
}

interface FirstLoadObservation {
  schema: 1;
  baseURL: string;
  marks: FirstLoadMarks;
  requests: RendererRequest[];
}

const marks: FirstLoadMarks = {};
const requests: RendererRequest[] = [];

function observeThrough<T extends object>(target: T, overrides: Record<PropertyKey, unknown>): T {
  return new Proxy(target, {
    get(subject, property) {
      if (Object.hasOwn(overrides, property)) return overrides[property];
      const value: unknown = Reflect.get(subject, property, subject);
      return typeof value === 'function' ? value.bind(subject) : value;
    },
  });
}

function observeLocator(locator: Locator): Locator {
  return observeThrough(locator, {
    waitFor: async (...args: Parameters<Locator['waitFor']>) => {
      await locator.waitFor(...args);
      if (marks.treeVisibleAt === undefined && marks.navigationStart !== undefined) {
        marks.treeVisibleAt = performance.now();
        marks.treeVisible = true;
      }
    },
  });
}

function observePage(page: Page): Page {
  page.on('request', (request) => {
    requests.push({
      url: request.url(),
      resourceType: request.resourceType(),
      at: performance.now(),
    });
  });
  return observeThrough(page, {
    goto: (...args: Parameters<Page['goto']>) => {
      if (marks.navigationStart !== undefined) return page.goto(...args);
      marks.navigationStart = performance.now();
      const navigation = page.goto(...args);
      navigation.then(
        () => {
          marks.navigationSettled = performance.now();
          marks.navigationOk = true;
        },
        () => {
          marks.navigationSettled = performance.now();
          marks.navigationOk = false;
        },
      );
      return navigation;
    },
    getByRole: (...args: Parameters<Page['getByRole']>) => observeLocator(page.getByRole(...args)),
  });
}

function observeContext(context: BrowserContext): BrowserContext {
  return observeThrough(context, {
    newPage: async () => {
      const page = await context.newPage();
      marks.pageReady ??= performance.now();
      return observePage(page);
    },
  });
}

function observeBrowser(browser: Browser): Browser {
  return observeThrough(browser, {
    newContext: async (...args: Parameters<Browser['newContext']>) => {
      marks.contextStart ??= performance.now();
      return observeContext(await browser.newContext(...args));
    },
  });
}

const test = base.extend<object, { firstLoadObservation: FirstLoadObservation }>({
  browser: [
    async ({ browser }, use) => {
      marks.workerSetupStart = performance.now();
      await use(observeBrowser(browser));
    },
    { scope: 'worker' },
  ],
  firstLoadObservation: [
    async ({ workerServer }, use) => {
      marks.workerSetupEnd = performance.now();
      const observation: FirstLoadObservation = {
        schema: 1,
        baseURL: workerServer.baseURL,
        marks: { ...marks },
        requests: [...requests],
      };
      const out = process.env.OK_MEASURE_OBSERVATION_OUT;
      if (!out) {
        throw new Error(
          'OK_MEASURE_OBSERVATION_OUT must name the file this observation is written to',
        );
      }
      writeFileSync(out, `${JSON.stringify(observation)}\n`);
      await use(observation);
    },
    { scope: 'worker' },
  ],
});

test('the worker warm-up loads the app and shows the required tree item', ({
  firstLoadObservation,
}) => {
  expect(firstLoadObservation.marks).toMatchObject({ navigationOk: true, treeVisible: true });
});
