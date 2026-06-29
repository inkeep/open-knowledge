import type { CDPSession } from '@playwright/test';
import {
  capturePerfMetricsWindow,
  enablePerformanceMetrics,
  type MinimalCdpClient,
} from '../lib/cdp-tracer';
import { correlateLongtasksWithMarks } from '../lib/correlate-longtasks';
import { installLongtaskObserver, readLongtasks } from '../lib/longtask-observer';
import { defineScenario } from '../lib/scenario';

const BIG_DOC = process.env.OK_PERF_BIG_DOC ?? 'PROJECT';
const PM_READY_CHARS = 500;
const PM_READY_TIMEOUT_MS = 90_000;

interface InlinePmStats {
  nodeCount: number;
  nodeCountByType: Record<string, number>;
  markCount: number;
  markCountByType: Record<string, number>;
  nodeViewCount: number;
  decorationCount: number;
  decorationCountByPlugin: Record<string, number>;
  runtimeMs: number;
}

async function getPmStatsInPage(
  page: import('@playwright/test').Page,
): Promise<InlinePmStats | null> {
  return page.evaluate(() => {
    const editor = (window as unknown as { __activeEditor?: unknown }).__activeEditor as
      | { state?: { doc?: unknown; plugins?: unknown[] }; view?: { nodeViews?: unknown } }
      | null
      | undefined;
    if (!editor?.state) return null;
    const startNs = typeof performance !== 'undefined' && performance.now ? performance.now() : 0;
    const state = editor.state as {
      doc: {
        descendants: (
          cb: (n: { type: { name: string }; marks: { type: { name: string } }[] }) => void,
        ) => void;
      };
      plugins: Array<{
        spec?: { key?: { key?: string } };
        key?: string;
        props?: { decorations?: (...args: unknown[]) => unknown };
      }>;
    };
    const nodeCountByType: Record<string, number> = {};
    const markCountByType: Record<string, number> = {};
    let nodeCount = 0;
    let markCount = 0;
    state.doc.descendants((node) => {
      nodeCount += 1;
      const t = node.type.name;
      nodeCountByType[t] = (nodeCountByType[t] ?? 0) + 1;
      for (const mark of node.marks) {
        markCount += 1;
        const m = mark.type.name;
        markCountByType[m] = (markCountByType[m] ?? 0) + 1;
      }
    });
    const view = editor.view as { nodeViews?: Record<string, unknown> } | undefined;
    const nodeViewCount = view?.nodeViews ? Object.keys(view.nodeViews).length : 0;
    const decorationCountByPlugin: Record<string, number> = {};
    let decorationCount = 0;
    for (let i = 0; i < state.plugins.length; i += 1) {
      const plugin = state.plugins[i];
      const fn = plugin.props?.decorations;
      if (typeof fn !== 'function') continue;
      const keyStr = plugin.spec?.key?.key ?? (plugin as { key?: string }).key ?? `unkeyed-${i}`;
      let pluginCount = 0;
      try {
        const result = fn.call(plugin, state) as
          | { forEachSet?: (cb: (set: { find: () => unknown[] }) => void) => void }
          | null
          | undefined;
        if (result && typeof result.forEachSet === 'function') {
          result.forEachSet((set) => {
            pluginCount += set.find().length;
          });
        }
      } catch {}
      decorationCountByPlugin[keyStr] = pluginCount;
      decorationCount += pluginCount;
    }
    const endNs = typeof performance !== 'undefined' && performance.now ? performance.now() : 0;
    return {
      nodeCount,
      nodeCountByType,
      markCount,
      markCountByType,
      nodeViewCount,
      decorationCount,
      decorationCountByPlugin,
      runtimeMs: Math.round((endNs - startNs) * 100) / 100,
    };
  });
}

interface UserMark {
  name: string;
  startTime: number;
  duration: number;
}

async function readUserMarks(page: import('@playwright/test').Page): Promise<UserMark[]> {
  return page.evaluate(() => {
    const entries = performance.getEntriesByType('measure');
    const out: Array<{ name: string; startTime: number; duration: number }> = [];
    for (const e of entries) {
      if (typeof e.name === 'string' && e.name.startsWith('ok/')) {
        out.push({ name: e.name, startTime: e.startTime, duration: e.duration });
      }
    }
    return out;
  });
}

function sumByPrefix(marks: UserMark[], prefix: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const m of marks) {
    if (!m.name.startsWith(prefix)) continue;
    const tag = m.name.slice(prefix.length);
    out[tag] = (out[tag] ?? 0) + Math.round(m.duration * 100) / 100;
  }
  return out;
}

function totalDurationByName(marks: UserMark[], name: string): number {
  let total = 0;
  for (const m of marks) {
    if (m.name === name) total += m.duration;
  }
  return Math.round(total * 100) / 100;
}

function lastMarkByName(marks: UserMark[], name: string): UserMark | null {
  let last: UserMark | null = null;
  for (const m of marks) {
    if (m.name === name && (last === null || m.startTime > last.startTime)) last = m;
  }
  return last;
}

export default defineScenario({
  name: 'g4-profile-decomposition',
  description:
    'Profile probe: decomposes PROJECT.md cold-MISS longest-task into JS / layout / style halves and cold-LOAD into IDB / WS / PM phases.',

  async run(ctx) {
    const { page, cdp, opts } = ctx;
    await installLongtaskObserver(page);
    const minimalCdp: MinimalCdpClient = cdp as unknown as MinimalCdpClient;
    await enablePerformanceMetrics(minimalCdp);

    const url = `${opts.target}/#/${encodeURIComponent(BIG_DOC)}`;
    ctx.recordMetric('docName', BIG_DOC);
    ctx.note(`g4 cold-mount probe target=${url}`);

    const pmStatsPre = await getPmStatsInPage(page).catch(() => null);

    const startWall = Date.now();
    const { result: rendered, deltas } = await capturePerfMetricsWindow(minimalCdp, async () => {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      try {
        await page.waitForSelector('.ProseMirror', {
          state: 'attached',
          timeout: PM_READY_TIMEOUT_MS,
        });
        await page.waitForFunction(
          (chars: number) => {
            const el = document.querySelector('.ProseMirror');
            return Boolean(el && (el.textContent ?? '').length >= chars);
          },
          PM_READY_CHARS,
          { timeout: PM_READY_TIMEOUT_MS },
        );
        return true;
      } catch {
        ctx.note(
          `ProseMirror did not render ≥${PM_READY_CHARS} chars within ${PM_READY_TIMEOUT_MS}ms`,
        );
        return false;
      }
    });
    const coldLoadMs = Date.now() - startWall;
    ctx.recordMetric('coldLoadMs', coldLoadMs);
    ctx.recordMetric('rendered', rendered);
    ctx.recordMetric('layoutMs', deltas.layoutMs);
    ctx.recordMetric('recalcStyleMs', deltas.recalcStyleMs);
    ctx.recordMetric('scriptMs', deltas.scriptMs);
    ctx.recordMetric('taskMs', deltas.taskMs);
    ctx.recordMetric('jsMs', deltas.scriptMs);

    const longTasks = await readLongtasks(page);
    const longestTaskMs = longTasks.reduce((m, t) => Math.max(m, t.duration), 0);
    ctx.recordMetric('observedLongTaskCount', longTasks.length);
    ctx.recordMetric('longestTaskMs', Math.round(longestTaskMs));

    const marks = await readUserMarks(page);
    ctx.recordMetric('totalUserMarkCount', marks.length);

    const perExtensionCost = sumByPrefix(
      marks.filter((m) => m.name.endsWith('-on-create')),
      'ok/cold/ext-',
    );
    const perDecorationCost = sumByPrefix(marks, 'ok/cold/decoration-');
    const perNodeViewCost = sumByPrefix(marks, 'ok/cold/nodeview-factory-');
    ctx.recordMetric('perExtensionCostJson', JSON.stringify(perExtensionCost));
    ctx.recordMetric('perDecorationCostJson', JSON.stringify(perDecorationCost));
    ctx.recordMetric('perNodeViewCostJson', JSON.stringify(perNodeViewCost));

    const idbAttach = lastMarkByName(marks, 'ok/pool/idb-attach');
    const syncedAfterIdb = lastMarkByName(marks, 'ok/pool/synced-after-idb');
    const editorMount = lastMarkByName(marks, 'ok/cold/editor-mount');
    const editorCreateView = lastMarkByName(marks, 'ok/cold/editor-create-view');
    const idbHydrateMs =
      syncedAfterIdb && idbAttach
        ? Math.round(
            (syncedAfterIdb.startTime + syncedAfterIdb.duration - idbAttach.startTime) * 100,
          ) / 100
        : null;
    const websocketSyncMs =
      editorMount && syncedAfterIdb
        ? Math.round(
            (editorMount.startTime - (syncedAfterIdb.startTime + syncedAfterIdb.duration)) * 100,
          ) / 100
        : null;
    const pmBuildMs =
      totalDurationByName(marks, 'ok/cold/editor-create-view') +
      totalDurationByName(marks, 'ok/cold/pm-update-state') +
      totalDurationByName(marks, 'ok/cold/pm-set-props');
    const idbAttachAtMs = idbAttach ? Math.round(idbAttach.startTime * 100) / 100 : null;
    ctx.recordMetric('idbAttachAtMs', idbAttachAtMs);
    ctx.recordMetric('idbHydrateMs', idbHydrateMs);
    ctx.recordMetric('websocketSyncMs', websocketSyncMs);
    ctx.recordMetric('pmBuildMs', pmBuildMs);
    if (editorCreateView) {
      ctx.recordMetric('editorCreateViewMs', Math.round(editorCreateView.duration * 100) / 100);
    }

    const correlation = correlateLongtasksWithMarks(longTasks, marks);
    const longestCorrelated = correlation.reduce(
      (best, cur) => (cur.taskMs > (best?.taskMs ?? 0) ? cur : best),
      null as ReturnType<typeof correlateLongtasksWithMarks>[number] | null,
    );
    if (longestCorrelated) {
      ctx.recordMetric(
        'longestTaskCorrelationJson',
        JSON.stringify(longestCorrelated.marksWithinTask),
      );
      ctx.recordMetric('longestTaskCorrelationMarkCount', longestCorrelated.marksWithinTask.length);
    } else {
      ctx.recordMetric('longestTaskCorrelationJson', '[]');
      ctx.recordMetric('longestTaskCorrelationMarkCount', 0);
    }

    const pmStatsPost = await getPmStatsInPage(page).catch(() => null);
    if (pmStatsPost) {
      ctx.recordMetric('pmStatsPostNodeCount', pmStatsPost.nodeCount);
      ctx.recordMetric('pmStatsPostMarkCount', pmStatsPost.markCount);
      ctx.recordMetric('pmStatsPostNodeViewCount', pmStatsPost.nodeViewCount);
      ctx.recordMetric('pmStatsPostDecorationCount', pmStatsPost.decorationCount);
      ctx.recordMetric('pmStatsRuntimeMs', pmStatsPost.runtimeMs);
      ctx.recordMetric(
        'pmStatsPostNodeCountByTypeJson',
        JSON.stringify(pmStatsPost.nodeCountByType),
      );
      ctx.recordMetric(
        'pmStatsPostMarkCountByTypeJson',
        JSON.stringify(pmStatsPost.markCountByType),
      );
      ctx.recordMetric(
        'pmStatsPostDecorationCountByPluginJson',
        JSON.stringify(pmStatsPost.decorationCountByPlugin),
      );
    } else {
      ctx.note('pmStatsPost capture failed — __activeEditor not exposed or editor not mounted');
    }
    ctx.recordMetric('pmStatsPreCapturedNonNull', pmStatsPre !== null);
  },
});

type _CdpSessionAlive = CDPSession;
