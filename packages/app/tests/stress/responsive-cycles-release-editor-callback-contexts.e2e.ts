import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CDPSession, Locator, Page } from '@playwright/test';
import { expect, test } from './_helpers';

const labels = ['alpha', 'bravo', 'charlie', 'delta'];

type HeapSnapshot = {
  snapshot: {
    meta: {
      node_fields: string[];
      edge_fields: string[];
      node_types: string[][];
      edge_types: string[][];
    };
  };
  nodes: number[];
  edges: number[];
  strings: string[];
};

function retainedContextDepth(path: string, docNames: string[]) {
  const heap = JSON.parse(readFileSync(path, 'utf8')) as HeapSnapshot;
  const { meta } = heap.snapshot;
  const nodeWidth = meta.node_fields.length;
  const edgeWidth = meta.edge_fields.length;
  const nodeTypeField = meta.node_fields.indexOf('type');
  const nodeNameField = meta.node_fields.indexOf('name');
  const nodeIdField = meta.node_fields.indexOf('id');
  const nodeEdgeCountField = meta.node_fields.indexOf('edge_count');
  const edgeTypeField = meta.edge_fields.indexOf('type');
  const edgeNameField = meta.edge_fields.indexOf('name_or_index');
  const edgeTargetField = meta.edge_fields.indexOf('to_node');
  const nodeTypes = meta.node_types[0] ?? [];
  const edgeTypes = meta.edge_types[0] ?? [];
  const nodeCount = heap.nodes.length / nodeWidth;
  const starts = new Uint32Array(nodeCount);
  let edgeIndex = 0;
  for (let index = 0; index < nodeCount; index++) {
    starts[index] = edgeIndex;
    edgeIndex += heap.nodes[index * nodeWidth + nodeEdgeCountField] ?? 0;
  }
  const nodeType = (index: number) => nodeTypes[heap.nodes[index * nodeWidth + nodeTypeField] ?? 0];
  const nodeName = (index: number) =>
    heap.strings[heap.nodes[index * nodeWidth + nodeNameField] ?? 0];
  const outgoing = (index: number) => {
    const edges: Array<{ type: string | undefined; name: string | undefined; target: number }> = [];
    const count = heap.nodes[index * nodeWidth + nodeEdgeCountField] ?? 0;
    for (let offset = 0; offset < count; offset++) {
      const edge = (starts[index] ?? 0) + offset;
      const type = edgeTypes[heap.edges[edge * edgeWidth + edgeTypeField] ?? 0];
      const nameIndex = heap.edges[edge * edgeWidth + edgeNameField] ?? 0;
      edges.push({
        type,
        name:
          type === 'property' || type === 'context' || type === 'internal'
            ? heap.strings[nameIndex]
            : undefined,
        target: (heap.edges[edge * edgeWidth + edgeTargetField] ?? 0) / nodeWidth,
      });
    }
    return edges;
  };

  const slots: number[] = [];
  for (let index = 0; index < nodeCount; index++) {
    if (nodeType(index) === 'native' && nodeName(index)?.includes('data-editor-file-list-slot')) {
      slots.push(index);
    }
  }
  expect(slots).toHaveLength(1);
  const refs = slots.flatMap((slot) =>
    outgoing(slot)
      .filter((edge) => edge.type === 'property' && edge.name?.startsWith('__reactProps$'))
      .flatMap((edge) =>
        outgoing(edge.target)
          .filter((candidate) => candidate.type === 'property' && candidate.name === 'ref')
          .map((candidate) => candidate.target)
          .filter((target) => nodeType(target) === 'closure'),
      ),
  );
  expect(refs).toHaveLength(1);

  const terminalHandles: number[] = [];
  for (let index = 0; index < nodeCount; index++) {
    if (nodeType(index) === 'native' && nodeName(index)?.includes('data-terminal-panel-handle')) {
      terminalHandles.push(index);
    }
  }
  expect(terminalHandles).toHaveLength(1);
  const terminalHandleCallbacks = terminalHandles.flatMap((handle) =>
    outgoing(handle)
      .filter((edge) => edge.type === 'property' && edge.name?.startsWith('__reactFiber$'))
      .flatMap((edge) =>
        outgoing(edge.target)
          .filter(
            (candidate) => candidate.type === 'property' && candidate.name === 'memoizedProps',
          )
          .flatMap((candidate) =>
            outgoing(candidate.target)
              .filter(
                (callback) => callback.type === 'property' && callback.name === 'onPointerDown',
              )
              .map((callback) => callback.target)
              .filter((target) => nodeType(target) === 'closure'),
          ),
      ),
  );
  expect(terminalHandleCallbacks).toHaveLength(1);

  const editorAreaPanels: number[] = [];
  for (let index = 0; index < nodeCount; index++) {
    if (nodeType(index) === 'native' && nodeName(index)?.includes('data-editor-area-panels')) {
      editorAreaPanels.push(index);
    }
  }
  expect(editorAreaPanels).toHaveLength(1);
  const editorAreaDestinationCallbacks = editorAreaPanels.flatMap((panel) =>
    outgoing(panel)
      .filter((edge) => edge.type === 'property' && edge.name?.startsWith('__reactFiber$'))
      .flatMap((edge) =>
        outgoing(edge.target)
          .filter((candidate) => candidate.type === 'property' && candidate.name === 'sibling')
          .flatMap((candidate) =>
            outgoing(candidate.target)
              .filter((props) => props.type === 'property' && props.name === 'memoizedProps')
              .flatMap((props) =>
                outgoing(props.target)
                  .filter((nested) => nested.type === 'property' && nested.name === 'props')
                  .flatMap((nested) =>
                    outgoing(nested.target)
                      .filter(
                        (callback) =>
                          callback.type === 'property' &&
                          callback.name === 'onDestinationRequested',
                      )
                      .map((callback) => callback.target)
                      .filter((target) => nodeType(target) === 'closure'),
                  ),
              ),
          ),
      ),
  );
  expect(editorAreaDestinationCallbacks).toHaveLength(1);

  const appMainNodes: number[] = [];
  for (let index = 0; index < nodeCount; index++) {
    if (nodeType(index) === 'native' && nodeName(index)?.includes('data-app-main=""')) {
      appMainNodes.push(index);
    }
  }
  expect(appMainNodes).toHaveLength(1);
  const appMainEffectCallbacks = appMainNodes.flatMap((node) =>
    outgoing(node)
      .filter((edge) => edge.type === 'property' && edge.name?.startsWith('__reactFiber$'))
      .flatMap((edge) =>
        outgoing(edge.target)
          .filter((candidate) => candidate.type === 'property' && candidate.name === 'child')
          .flatMap((candidate) =>
            outgoing(candidate.target)
              .filter((queue) => queue.type === 'property' && queue.name === 'updateQueue')
              .flatMap((queue) =>
                outgoing(queue.target)
                  .filter((effect) => effect.type === 'property' && effect.name === 'lastEffect')
                  .flatMap((effect) =>
                    outgoing(effect.target)
                      .filter((create) => create.type === 'property' && create.name === 'create')
                      .map((create) => create.target)
                      .filter((target) => nodeType(target) === 'closure'),
                  ),
              ),
          ),
      ),
  );
  expect(appMainEffectCallbacks).toHaveLength(1);

  const expectedQueryHashes = new Map(
    docNames.map((docName) => [JSON.stringify(['page-headings', docName]), docName]),
  );
  const queryRoots = new Map<string, number[]>();
  for (let index = 0; index < nodeCount; index++) {
    if (nodeType(index) !== 'object') continue;
    const edges = outgoing(index);
    const queryHash = edges.find((edge) => edge.type === 'property' && edge.name === 'queryHash');
    if (!queryHash) continue;
    const docName = expectedQueryHashes.get(nodeName(queryHash.target) ?? '');
    if (!docName) continue;
    const options = edges.find((edge) => edge.type === 'property' && edge.name === 'options');
    const observers = edges.find((edge) => edge.type === 'property' && edge.name === 'observers');
    if (!options || !observers) continue;
    const queryFn = outgoing(options.target).find(
      (edge) => edge.type === 'property' && edge.name === 'queryFn',
    );
    if (!queryFn || nodeType(queryFn.target) !== 'closure') continue;
    const roots = queryRoots.get(docName) ?? [];
    roots.push(queryFn.target);
    queryRoots.set(docName, roots);
  }
  for (const docName of docNames) expect(queryRoots.get(docName)).toHaveLength(1);

  const depthFrom = (roots: number[], trace = false) => {
    const visited = new Uint8Array(nodeCount);
    const parents = trace ? new Uint32Array(nodeCount) : null;
    const queue = roots.map((index) => ({ index, depth: 0 }));
    for (const root of roots) visited[root] = 1;
    let maxDepth = 0;
    let front = 0;
    let contexts = 0;
    let deepest = roots[0] ?? 0;
    while (front < queue.length) {
      const { index, depth } = queue[front++] ?? { index: 0, depth: 0 };
      if (depth > maxDepth) {
        maxDepth = depth;
        deepest = index;
      }
      if (nodeName(index) === 'system / Context') contexts++;
      for (const edge of outgoing(index)) {
        if (visited[edge.target]) continue;
        const entersContext =
          nodeType(index) === 'closure' &&
          edge.type === 'internal' &&
          edge.name === 'context' &&
          nodeName(edge.target) === 'system / Context';
        const entersClosure =
          nodeName(index) === 'system / Context' &&
          edge.type === 'context' &&
          nodeType(edge.target) === 'closure';
        if (!entersContext && !entersClosure) continue;
        visited[edge.target] = 1;
        if (parents) parents[edge.target] = index + 1;
        queue.push({ index: edge.target, depth: depth + 1 });
      }
    }
    if (!parents) return { maxDepth, contexts };
    const chain = [];
    for (let index = deepest; ; ) {
      const parent = (parents[index] ?? 0) - 1;
      const via =
        parent < 0
          ? null
          : outgoing(parent).find((edge) => edge.target === index && edge.type !== 'weak');
      chain.push({
        id: heap.nodes[index * nodeWidth + nodeIdField] ?? 0,
        type: nodeType(index),
        name: nodeName(index),
        via: via == null ? null : { type: via.type, name: via.name },
      });
      if (parent < 0) break;
      index = parent;
    }
    chain.reverse();
    return { maxDepth, contexts, chain: chain.slice(0, 256), chainTruncated: chain.length > 256 };
  };

  const pageHeadingsByDoc = Object.fromEntries(
    docNames.map((docName) => [docName, depthFrom(queryRoots.get(docName) ?? [])]),
  );
  return {
    files: depthFrom(refs),
    terminalHandle: depthFrom(
      terminalHandleCallbacks,
      process.env.QA101_CONTEXT_CHAIN_TRACE === '1',
    ),
    editorAreaDestination: depthFrom(
      editorAreaDestinationCallbacks,
      process.env.QA101_CONTEXT_CHAIN_TRACE === '1',
    ),
    appMainEffect: depthFrom(appMainEffectCallbacks, process.env.QA101_CONTEXT_CHAIN_TRACE === '1'),
    pageHeadings: {
      maxDepth: Math.max(...Object.values(pageHeadingsByDoc).map((result) => result.maxDepth)),
      byDoc: pageHeadingsByDoc,
    },
  };
}

async function snapshotDepth(cdp: CDPSession, path: string, docNames: string[]) {
  await cdp.send('HeapProfiler.collectGarbage');
  const fd = openSync(path, 'w');
  let bytes = 0;
  const onChunk = ({ chunk }: { chunk: string }) => {
    bytes += writeSync(fd, chunk);
  };
  try {
    cdp.on('HeapProfiler.addHeapSnapshotChunk', onChunk);
    try {
      await cdp.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false });
    } finally {
      cdp.off('HeapProfiler.addHeapSnapshotChunk', onChunk);
      closeSync(fd);
    }
    expect(bytes).toBeGreaterThan(0);
    return retainedContextDepth(path, docNames);
  } finally {
    if (existsSync(path)) unlinkSync(path);
  }
}

function paneTabs(page: Page): Locator {
  return page.locator('[data-editor-header-tabs] [data-editor-pane-tabs]');
}

async function openDocFromSidebar(page: Page, docName: string, body: string) {
  await page
    .locator('[data-slot="sidebar-container"]')
    .getByRole('treeitem', { name: `${docName}.md`, exact: true })
    .click();
  await expect(
    page.locator(`[data-editor-activity-mount][data-doc-name="${docName}"]`),
  ).toContainText(body);
  const tab = page.locator(
    `[data-editor-pane-focused] [data-editor-tab-sortable][data-editor-tab-id="${docName}"]`,
  );
  if ((await tab.getAttribute('data-preview-tab')) === 'true') {
    await tab.click({ button: 'right' });
    await page.getByTestId('editor-tab-context-keep-open').click();
  }
}

async function dragTabToRightEdge(page: Page, tab: Locator, paneId: string) {
  const tabBox = await tab.boundingBox();
  if (!tabBox) throw new Error('tab has no box');
  await page.mouse.move(tabBox.x + tabBox.width / 2, tabBox.y + tabBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(tabBox.x + tabBox.width / 2 + 12, tabBox.y + tabBox.height / 2, {
    steps: 2,
  });
  const edge = page.locator(`section[data-editor-pane-id="${paneId}"] [data-pane-edge="right"]`);
  await expect(edge).toBeAttached();
  const edgeBox = await edge.boundingBox();
  if (!edgeBox) throw new Error('pane edge has no box');
  await page.mouse.move(edgeBox.x + edgeBox.width / 2, edgeBox.y + edgeBox.height / 2, {
    steps: 8,
  });
  await expect(edge).toHaveAttribute('data-pane-drop-side', 'right');
  await page.mouse.up();
}

async function fullCycle(page: Page, docName: string, paneNumber: number) {
  await page.setViewportSize({ width: 390, height: 800 });
  const selector = page.getByRole('combobox', { name: 'Editor pane' });
  await expect(selector).toBeVisible();
  await selector.click();
  await page.getByRole('option', { name: `Pane ${paneNumber}` }).click();
  await expect(
    page.locator(`[data-editor-activity-mount][data-doc-name="${docName}"]`),
  ).toBeVisible();
  await page.locator('[data-sidebar="trigger"]').click();
  await expect(page.locator('[data-files-cover]')).toBeVisible();
  await page.keyboard.press('ControlOrMeta+Alt+KeyB');
  await expect(page.locator('[data-doc-panel-cover]')).toBeVisible();
  await page.locator('[data-doc-panel-back]').click();
  await expect(page.locator('[data-doc-panel-cover]')).toHaveCount(0);
  await page.setViewportSize({ width: 2400, height: 900 });
  await expect(paneTabs(page)).toHaveCount(4);
  await expect(page.locator('#doc-panel')).toBeVisible();
}

async function verifyFileHostMovement(page: Page) {
  const host = await page.locator('[data-file-list-host]').elementHandle();
  if (!host) throw new Error('Files host is missing');
  try {
    await page.setViewportSize({ width: 390, height: 800 });
    await expect(page.locator('[data-editor-file-list-slot] [data-file-list-host]')).toHaveCount(1);
    await page.locator('[data-sidebar="trigger"]').click();
    await expect(page.locator('[data-files-cover]')).toBeVisible();
    await expect
      .poll(() =>
        host.evaluate(
          (element) =>
            element.isConnected &&
            element === document.querySelector('[data-files-cover] [data-file-list-host]'),
        ),
      )
      .toBe(true);
    await page.locator('[data-files-back]').click();
    await expect(page.locator('[data-files-cover]')).toHaveCount(0);
    await expect
      .poll(() =>
        host.evaluate(
          (element) =>
            element.isConnected &&
            element ===
              document.querySelector('[data-editor-file-list-slot] [data-file-list-host]'),
        ),
      )
      .toBe(true);
    await page.setViewportSize({ width: 2400, height: 900 });
    await expect(page.locator('#doc-panel')).toBeVisible();
  } finally {
    await host.dispose();
  }
}

async function verifyDestinationBranches(page: Page, docName: string, heading: string) {
  const editor = page.locator(
    `[data-editor-activity-mount][data-doc-name="${docName}"] .ProseMirror[contenteditable="true"]`,
  );
  await test.step('closed cover leaves the visible destination and outline focus intact', async () => {
    const outlineButton = page.locator('#panel-outline').getByRole('button', {
      name: heading,
      exact: true,
    });
    await expect(outlineButton).toBeVisible();
    await outlineButton.click();
    await expect(page.locator('[data-doc-panel-cover]')).toHaveCount(0);
    await expect(editor).toBeVisible();
    await expect(outlineButton).toBeFocused();
  });

  await test.step('open cover closes and focuses the visible destination', async () => {
    await page.setViewportSize({ width: 390, height: 800 });
    await page.locator('[data-doc-panel-toggle]').click();
    const cover = page.locator('[data-doc-panel-cover]');
    await expect(cover).toBeVisible();
    await cover.getByRole('button', { name: heading, exact: true }).click();
    await expect(cover).toHaveCount(0);
    await expect(editor).toBeVisible();
    await expect(editor).toBeFocused();
    await page.setViewportSize({ width: 2400, height: 900 });
    await expect(page.locator('#doc-panel')).toBeVisible();
  });
}

const APP_DIST = join(dirname(fileURLToPath(import.meta.url)), '../../dist');

test.use({ video: 'off', trace: 'off', workerServerEnv: { OK_TEST_PRODUCTION_SHELL: '1' } });

test('responsive cycles release prior editor callback contexts', async ({
  page,
  api,
  workerServer,
}) => {
  test.setTimeout(240_000);
  expect(workerServer.launch?.mode).toBe('production');
  expect(workerServer.launch?.command).toBe(process.execPath);
  expect(workerServer.launch?.args.slice(1, 2)).toEqual(['start']);
  expect(workerServer.launch?.args).toContain(APP_DIST);
  const servedIndex = await (await fetch(`${workerServer.baseURL}/`)).text();
  const entry = /<script[^>]+type="module"[^>]+src="\.?\/(assets\/[^"]+\.js)"/.exec(
    servedIndex,
  )?.[1];
  if (!entry) throw new Error('production index served no hashed module entry');
  expect(readFileSync(join(APP_DIST, 'index.html'), 'utf8')).toContain(entry);
  const servedEntry = Buffer.from(
    await (await fetch(`${workerServer.baseURL}/${entry}`)).arrayBuffer(),
  );
  expect(createHash('sha256').update(servedEntry).digest('hex')).toBe(
    createHash('sha256')
      .update(readFileSync(join(APP_DIST, entry)))
      .digest('hex'),
  );
  expect(relative(tmpdir(), workerServer.contentDir).startsWith('..')).toBe(false);
  const suffix = randomUUID().slice(0, 8);
  const docs = labels.map((label) => ({
    name: `qa101-context-${label}-${suffix}`,
    markdown: `# ${label}-${suffix}\n\n${label} retained body\n`,
    body: `${label} retained body`,
  }));
  const firstDoc = docs.at(0);
  if (!firstDoc) throw new Error('missing first document');
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  for (const doc of docs) await api.createPage(`${doc.name}.md`);
  for (const doc of docs) await api.replaceDoc(doc.name, doc.markdown);
  await expect
    .poll(() => docs.every((doc) => existsSync(join(workerServer.contentDir, `${doc.name}.md`))))
    .toBe(true);

  await page.setViewportSize({ width: 2400, height: 900 });
  await page.goto(`/#/${firstDoc.name}`);
  await expect(
    page.locator(`[data-editor-activity-mount][data-doc-name="${firstDoc.name}"]`),
  ).toContainText(firstDoc.body);
  for (const doc of docs.slice(1)) {
    await page
      .locator('[data-editor-pane-focused] [data-editor-pane-tabs]')
      .getByTestId('editor-new-tab-button')
      .click();
    await openDocFromSidebar(page, doc.name, doc.body);
    const ids = await paneTabs(page).evaluateAll((strips) =>
      strips.map((strip) => strip.getAttribute('data-editor-pane-tabs')).filter((id) => id != null),
    );
    const paneId = ids.at(-1);
    if (!paneId) throw new Error('focused pane is missing');
    const tab = page.locator(
      `[data-editor-pane-tabs="${paneId}"] [data-editor-tab-sortable][data-editor-tab-id="${doc.name}"]`,
    );
    await dragTabToRightEdge(page, tab, paneId);
    await expect(paneTabs(page)).toHaveCount(ids.length + 1);
  }
  await expect(page.locator('[data-editor-activity-mount]')).toHaveCount(4);
  await expect(page.locator('.ProseMirror:not(.composer-prosemirror)')).toHaveCount(4);
  await test.step('Files host survives cover movement', () => verifyFileHostMovement(page));
  const lastDoc = docs.at(-1);
  if (!lastDoc) throw new Error('missing last document');
  await verifyDestinationBranches(page, lastDoc.name, `delta-${suffix}`);

  const cdp = await page.context().newCDPSession(page);
  try {
    for (let cycle = 0; cycle < 4; cycle++) {
      const doc = docs[cycle % docs.length];
      if (!doc) throw new Error('missing cycle document');
      await fullCycle(page, doc.name, (cycle % docs.length) + 1);
    }
    await page.evaluate(() => performance.clearMeasures());
    await expect(page.locator('[data-editor-file-list-slot]')).toHaveCount(1);
    const before = await snapshotDepth(
      cdp,
      test.info().outputPath('context-before.heapsnapshot'),
      docs.map((doc) => doc.name),
    );
    for (let cycle = 4; cycle < 20; cycle++) {
      const doc = docs[cycle % docs.length];
      if (!doc) throw new Error('missing cycle document');
      await fullCycle(page, doc.name, (cycle % docs.length) + 1);
    }
    await page.evaluate(() => performance.clearMeasures());
    await expect(page.locator('[data-editor-activity-mount]')).toHaveCount(4);
    await expect(page.locator('.ProseMirror:not(.composer-prosemirror)')).toHaveCount(4);
    await expect(page.locator('[data-editor-file-list-slot]')).toHaveCount(1);
    const after = await snapshotDepth(
      cdp,
      test.info().outputPath('context-after.heapsnapshot'),
      docs.map((doc) => doc.name),
    );
    const evidencePath = test.info().outputPath('context-retention.json');
    writeFileSync(
      evidencePath,
      JSON.stringify({ before, after, cyclesBetween: 16, pageErrors }, null, 2),
    );
    await test.info().attach('context-retention.json', {
      path: evidencePath,
      contentType: 'application/json',
    });
    expect(pageErrors).toEqual([]);
    expect.soft(after.pageHeadings.maxDepth - before.pageHeadings.maxDepth).toBeLessThanOrEqual(8);
    expect.soft(after.files.maxDepth - before.files.maxDepth).toBeLessThanOrEqual(8);
    expect
      .soft(after.terminalHandle.maxDepth - before.terminalHandle.maxDepth)
      .toBeLessThanOrEqual(8);
    expect
      .soft(after.editorAreaDestination.maxDepth - before.editorAreaDestination.maxDepth)
      .toBeLessThanOrEqual(8);
    expect
      .soft(after.appMainEffect.maxDepth - before.appMainEffect.maxDepth)
      .toBeLessThanOrEqual(8);
  } finally {
    await cdp.detach();
  }
});
