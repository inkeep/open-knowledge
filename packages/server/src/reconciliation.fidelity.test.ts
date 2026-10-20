import { MarkdownManager, sharedExtensions } from '@inkeep/open-knowledge-core';
import { describe, expect, test } from 'vitest';
import { getMetrics } from './metrics';
import {
  checkMergeOutput,
  countKeptBlocks,
  MAX_CONSTRUCT_CHECK_BYTES,
  MAX_LCS_CELLS,
  reconcile,
} from './reconciliation';

const docName = 'fidelity-doc';
const cleanMerge = { dedupSkipped: false } as const;
const parser = new MarkdownManager({ extensions: sharedExtensions });
const rootTypes = (md: string): string[] => parser.parseToMdast(md).children.map((c) => c.type);

interface SpikeCase {
  readonly name: string;
  readonly base: string;
  readonly ours: string;
  readonly theirs: string;
  readonly expected:
    | { readonly kind: 'noop' }
    | { readonly kind: 'clean' | 'merged'; readonly newContent: string };
}

const SPIKE_CASES: readonly SpikeCase[] = [
  {
    name: 'CONTROL-1 all-LF canonical document, both sides edit different blocks',
    base: '# Title\n\nPara one.\n\nPara two.\n\nPara three.\n',
    ours: '# Title\n\nPara one EDITED by ours.\n\nPara two.\n\nPara three.\n',
    theirs: '# Title\n\nPara one.\n\nPara two.\n\nPara three EDITED by theirs.\n',
    expected: {
      kind: 'merged',
      newContent:
        '# Title\n\nPara one EDITED by ours.\n\nPara two.\n\nPara three EDITED by theirs.\n',
    },
  },
  {
    name: 'CONTROL-2 ours, theirs and base identical',
    base: '# Title\n\nPara one.\n\nPara two.\n\nPara three.\n',
    ours: '# Title\n\nPara one.\n\nPara two.\n\nPara three.\n',
    theirs: '# Title\n\nPara one.\n\nPara two.\n\nPara three.\n',
    expected: { kind: 'noop' },
  },
  {
    name: 'CONTROL-3 ours equals base, so theirs lands verbatim',
    base: '# Title\r\n\r\n    code line 1\r\n    code line 2\r\n\r\nAfter.\r\n',
    ours: '# Title\r\n\r\n    code line 1\r\n    code line 2\r\n\r\nAfter.\r\n',
    theirs: '# Title\r\n\r\n    code line 1\r\n    code line 2\r\n\r\nAfter EDITED by theirs.\r\n',
    expected: {
      kind: 'clean',
      newContent:
        '# Title\r\n\r\n    code line 1\r\n    code line 2\r\n\r\nAfter EDITED by theirs.\r\n',
    },
  },
  {
    name: 'Q1.a CRLF base and ours with one-line blocks, LF theirs edits another block',
    base: '# Title\r\n\r\nPara one.\r\n\r\nPara two.\r\n',
    ours: '# Title\r\n\r\nPara one EDITED by ours.\r\n\r\nPara two.\r\n',
    theirs: '# Title\n\nPara one.\n\nPara two EDITED by theirs.\n',
    expected: {
      kind: 'merged',
      newContent: '# Title\n\nPara one EDITED by ours.\n\nPara two EDITED by theirs.\n',
    },
  },
  {
    name: 'Q1.b CRLF ours edit makes a two-line block, LF theirs edits another block',
    base: '# Title\r\n\r\nPara one.\r\n\r\nPara two.\r\n',
    ours: '# Title\r\n\r\nPara one EDITED by ours.\r\nSecond line by ours.\r\n\r\nPara two.\r\n',
    theirs: '# Title\n\nPara one.\n\nPara two EDITED by theirs.\n',
    expected: {
      kind: 'merged',
      newContent:
        '# Title\n\nPara one EDITED by ours.\nSecond line by ours.\n\nPara two EDITED by theirs.\n',
    },
  },
  {
    name: 'Q1.c CRLF untouched two-line block, LF theirs edits another block',
    base: '# Title\r\n\r\nMulti one.\r\nMulti two.\r\n\r\nPara A.\r\n\r\nPara B.\r\n',
    ours: '# Title\r\n\r\nMulti one.\r\nMulti two.\r\n\r\nPara A EDITED by ours.\r\n\r\nPara B.\r\n',
    theirs: '# Title\n\nMulti one.\nMulti two.\n\nPara A.\n\nPara B EDITED by theirs.\n',
    expected: {
      kind: 'merged',
      newContent:
        '# Title\n\nMulti one.\nMulti two.\n\nPara A EDITED by ours.\n\nPara B EDITED by theirs.\n',
    },
  },
  {
    name: 'Q1.d CRLF ours edits a two-line block whose LF theirs copy differs only in endings',
    base: '# Title\r\n\r\nMulti one.\r\nMulti two.\r\n\r\nPara B.\r\n',
    ours: '# Title\r\n\r\nMulti one EDITED by ours.\r\nMulti two.\r\n\r\nPara B.\r\n',
    theirs: '# Title\n\nMulti one.\nMulti two.\n\nPara B EDITED by theirs.\n',
    expected: {
      kind: 'merged',
      newContent: '# Title\n\nMulti one EDITED by ours.\nMulti two.\n\nPara B EDITED by theirs.\n',
    },
  },
  {
    name: 'Q1.e LF base and ours, CRLF theirs edits a two-line block',
    base: '# Title\n\nPara A.\n\nPara B.\nPara B continued.\n',
    ours: '# Title\n\nPara A EDITED by ours.\n\nPara B.\nPara B continued.\n',
    theirs: '# Title\r\n\r\nPara A.\r\n\r\nPara B EDITED by theirs.\r\nPara B continued.\r\n',
    expected: {
      kind: 'merged',
      newContent:
        '# Title\r\n\r\nPara A EDITED by ours.\r\n\r\nPara B EDITED by theirs.\r\nPara B continued.\r\n',
    },
  },
  {
    name: 'Q1.f all-CRLF triple with one-line blocks',
    base: '# Title\r\n\r\nPara one.\r\n\r\nPara two.\r\n',
    ours: '# Title\r\n\r\nPara one EDITED by ours.\r\n\r\nPara two.\r\n',
    theirs: '# Title\r\n\r\nPara one.\r\n\r\nPara two EDITED by theirs.\r\n',
    expected: {
      kind: 'merged',
      newContent: '# Title\r\n\r\nPara one EDITED by ours.\r\n\r\nPara two EDITED by theirs.\r\n',
    },
  },
  {
    name: 'Q1.g all-CRLF triple with two-line blocks',
    base: '# Title\r\n\r\nA1.\r\nA2.\r\n\r\nB1.\r\nB2.\r\n\r\nC1.\r\nC2.\r\n',
    ours: '# Title\r\n\r\nA1 EDITED by ours.\r\nA2.\r\n\r\nB1.\r\nB2.\r\n\r\nC1.\r\nC2.\r\n',
    theirs: '# Title\r\n\r\nA1.\r\nA2.\r\n\r\nB1.\r\nB2.\r\n\r\nC1 EDITED by theirs.\r\nC2.\r\n',
    expected: {
      kind: 'merged',
      newContent:
        '# Title\r\n\r\nA1 EDITED by ours.\r\nA2.\r\n\r\nB1.\r\nB2.\r\n\r\nC1 EDITED by theirs.\r\nC2.\r\n',
    },
  },
  {
    name: 'Q2.a four-space indented code block at a block boundary',
    base: '# Title\n\nIntro.\n\n    code line 1\n    code line 2\n\nAfter.\n',
    ours: '# Title\n\nIntro EDITED by ours.\n\n    code line 1\n    code line 2\n\nAfter.\n',
    theirs: '# Title\n\nIntro.\n\n    code line 1\n    code line 2\n\nAfter EDITED by theirs.\n',
    expected: {
      kind: 'merged',
      newContent:
        '# Title\n\nIntro EDITED by ours.\n\n    code line 1\n    code line 2\n\nAfter EDITED by theirs.\n',
    },
  },
  {
    name: 'Q2.b four-space indented list continuation paragraph',
    base: 'Intro.\n\n- item one\n\n    continuation of item one\n\n- item two\n\nAfter.\n',
    ours: 'Intro EDITED by ours.\n\n- item one\n\n    continuation of item one\n\n- item two\n\nAfter.\n',
    theirs:
      'Intro.\n\n- item one\n\n    continuation of item one\n\n- item two\n\nAfter EDITED by theirs.\n',
    expected: {
      kind: 'merged',
      newContent:
        'Intro EDITED by ours.\n\n- item one\n\n    continuation of item one\n\n- item two\n\nAfter EDITED by theirs.\n',
    },
  },
  {
    name: 'Q2.c two-space indented list continuation paragraph',
    base: 'Intro.\n\n- item one\n\n  continuation of item one\n\n- item two\n\nAfter.\n',
    ours: 'Intro EDITED by ours.\n\n- item one\n\n  continuation of item one\n\n- item two\n\nAfter.\n',
    theirs:
      'Intro.\n\n- item one\n\n  continuation of item one\n\n- item two\n\nAfter EDITED by theirs.\n',
    expected: {
      kind: 'merged',
      newContent:
        'Intro EDITED by ours.\n\n- item one\n\n  continuation of item one\n\n- item two\n\nAfter EDITED by theirs.\n',
    },
  },
];

describe('the thirteen CRLF and indentation spike cases merge byte-exact', () => {
  test.each(SPIKE_CASES)('$name', ({ base, ours, theirs, expected }) => {
    const outcome = reconcile({ docName, base, ours, theirs });
    expect(outcome).toMatchObject(expected);
  });

  test.each(SPIKE_CASES.filter((c) => c.name.startsWith('Q2')))(
    'the core parser reads the same root constructs in base and output: $name',
    ({ base, ours, theirs }) => {
      const outcome = reconcile({ docName, base, ours, theirs });
      if (outcome.kind !== 'merged') throw new Error(`expected merged, got ${outcome.kind}`);
      expect(rootTypes(outcome.newContent)).toEqual(rootTypes(base));
    },
  );
});

describe('assembly keeps every separator, leading and trailing byte', () => {
  test('two blank lines stay two and a missing final newline stays missing', () => {
    const outcome = reconcile({
      docName,
      base: 'A\n\n\nB\n\nC',
      ours: 'A ours\n\n\nB\n\nC',
      theirs: 'A\n\n\nB\n\nC theirs',
    });
    expect(outcome).toEqual({
      kind: 'merged',
      newContent: 'A ours\n\n\nB\n\nC theirs',
      mergedBlocks: 3,
    });
  });

  test('a separator one side changed before an untouched block keeps that change', () => {
    const outcome = reconcile({
      docName,
      base: 'A\n\nB\n\nC\n',
      ours: 'A\n\n\n\nB\n\nC\n',
      theirs: 'A\n\nB\n\nC theirs\n',
    });
    expect(outcome).toMatchObject({ kind: 'merged', newContent: 'A\n\n\n\nB\n\nC theirs\n' });
  });

  test("a side's modified block and its inserted block carry that side's separators", () => {
    const outcome = reconcile({
      docName,
      base: 'A\n\nB\n\nC\n',
      ours: 'A ours\n\nB\n\nC\n',
      theirs: 'A\n\n\n\nB theirs\n\n\nX theirs\n\nC\n',
    });
    expect(outcome).toMatchObject({
      kind: 'merged',
      newContent: 'A ours\n\n\n\nB theirs\n\n\nX theirs\n\nC\n',
    });
  });

  test('deleting the first block leaves no leading blank lines', () => {
    const outcome = reconcile({
      docName,
      base: 'A\n\nB\n',
      ours: 'B\n',
      theirs: 'A\n\nB\n\nC\n',
    });
    expect(outcome).toMatchObject({ kind: 'merged', newContent: 'B\n\nC\n' });
  });

  test('trailing bytes come from theirs when theirs changed them, otherwise from ours', () => {
    expect(
      reconcile({ docName, base: 'A\n\nB', ours: 'A ours\n\nB', theirs: 'A\n\nB\n' }),
    ).toMatchObject({ kind: 'merged', newContent: 'A ours\n\nB\n' });
    expect(
      reconcile({ docName, base: 'A\n\nB\n', ours: 'A ours\n\nB', theirs: 'A\n\nB theirs\n' }),
    ).toMatchObject({ kind: 'merged', newContent: 'A ours\n\nB theirs' });
  });
});

describe('line endings', () => {
  test('when ours converted the whole file and theirs did not, the output takes ours convention', () => {
    const outcome = reconcile({
      docName,
      base: '# T\r\n\r\nA.\r\nA2.\r\n\r\nB.\r\n',
      ours: '# T\n\nA ours.\nA2.\n\nB.\n',
      theirs: '# T\r\n\r\nA.\r\nA2.\r\n\r\nB theirs.\r\n',
    });
    expect(outcome).toMatchObject({
      kind: 'merged',
      newContent: '# T\n\nA ours.\nA2.\n\nB theirs.\n',
    });
  });

  test('when both sides converted a mixed file to different conventions, theirs wins', () => {
    const outcome = reconcile({
      docName,
      base: '# T\r\n\r\nA.\n\nB.\r\n',
      ours: '# T\n\nA ours.\n\nB.\n',
      theirs: '# T\r\n\r\nA.\r\n\r\nB theirs.\r\n',
    });
    expect(outcome).toMatchObject({
      kind: 'merged',
      newContent: '# T\r\n\r\nA ours.\r\n\r\nB theirs.\r\n',
    });
  });

  test('without a whole-file conversion each block keeps its own endings', () => {
    const outcome = reconcile({
      docName,
      base: '# T\r\n\r\nA.\r\n\r\nB.\r\nB2.\r\n',
      ours: '# T\r\n\r\nA ours.\r\n\r\nB.\r\nB2.\r\n',
      theirs: '# T\r\n\r\nA.\r\n\r\nB theirs.\nB2.\r\n',
    });
    expect(outcome).toMatchObject({
      kind: 'merged',
      newContent: '# T\r\n\r\nA ours.\r\n\r\nB theirs.\nB2.\r\n',
    });
  });
});

describe('classification under the raw-byte definition of changed', () => {
  test('both sides making the identical edit land it once', () => {
    const outcome = reconcile({
      docName,
      base: 'A\n\nB\n\nC\n',
      ours: 'A\n\nB edited\n\nC\n',
      theirs: 'A\n\nB edited\n\nC\n',
    });
    expect(outcome).toEqual({
      kind: 'merged',
      newContent: 'A\n\nB edited\n\nC\n',
      mergedBlocks: 3,
    });
  });

  test('a whitespace-only outside change inside a paragraph ours edited keeps both versions', () => {
    const outcome = reconcile({
      docName,
      base: 'A\n\nPara text here.\n\nC\n',
      ours: 'A\n\nPara text EDITED.\n\nC\n',
      theirs: 'A\n\nPara  text here.\n\nC theirs\n',
    });
    expect(outcome).toEqual({
      kind: 'both-kept',
      newContent: 'A\n\nPara text EDITED.\n\nPara  text here.\n\nC theirs\n',
      kept: [
        {
          blockIndex: 1,
          base: 'Para text here.',
          ours: 'Para text EDITED.',
          theirs: 'Para  text here.',
          landed: 'both',
        },
      ],
    });
  });

  test('an insert the engine reads as an edit, beside the same insert from theirs, is refused instead of landing twice', () => {
    const outcome = reconcile({
      docName,
      base: 'A\n\nB\n\nC\n',
      ours: 'A\n\nX\n\nB edited\n\nC\n',
      theirs: 'A\n\nX\n\nB\n\nC\n',
    });
    expect(outcome).toEqual({
      kind: 'refused',
      reason: 'check-failed',
      failure: { check: 'single-occurrence', outputBlockIndex: 2 },
    });
  });

  test('the size cap still refuses as too-large before any merge or check runs', () => {
    const perSide = Math.ceil(Math.sqrt(MAX_LCS_CELLS)) + 10;
    const blocks = (prefix: string): string =>
      `${Array.from({ length: perSide }, (_, i) => `${prefix} ${i}.`).join('\r\n\r\n')}\r\n`;
    const outcome = reconcile({
      docName,
      base: blocks('base'),
      ours: blocks('ours'),
      theirs: blocks('theirs'),
    });
    expect(outcome).toEqual({ kind: 'refused', reason: 'too-large' });
  });
});

describe('a block both sides changed keeps both versions, ours first', () => {
  test('a mid-document paragraph lands ours then theirs, each byte-exact, with no markers', () => {
    expect(
      reconcile({
        docName,
        base: '# Title\n\nShared.\n\nTail.\n',
        ours: '# Title\n\nShared, ours.\n\nTail.\n',
        theirs: '# Title\n\nShared, theirs.\n\nTail.\n',
      }),
    ).toEqual({
      kind: 'both-kept',
      newContent: '# Title\n\nShared, ours.\n\nShared, theirs.\n\nTail.\n',
      kept: [
        {
          blockIndex: 1,
          base: 'Shared.',
          ours: 'Shared, ours.',
          theirs: 'Shared, theirs.',
          landed: 'both',
        },
      ],
    });
  });

  test("the gap between the two versions is theirs' own separator before its version", () => {
    const outcome = reconcile({
      docName,
      base: 'A\n\nB\n\nC\n',
      ours: 'A\n\nB ours\n\nC\n',
      theirs: 'A\n\n\nB theirs\n\nC\n',
    });
    expect(outcome).toMatchObject({
      kind: 'both-kept',
      newContent: 'A\n\n\nB ours\n\n\nB theirs\n\nC\n',
    });
  });

  test('a first-block collision separates the two versions with the document blank line', () => {
    expect(
      reconcile({ docName, base: 'A\n\nB\n', ours: 'A ours\n\nB\n', theirs: 'A theirs\n\nB\n' }),
    ).toMatchObject({ kind: 'both-kept', newContent: 'A ours\n\nA theirs\n\nB\n' });
    expect(
      reconcile({ docName, base: 'A\n', ours: 'A ours\n', theirs: 'A theirs\n' }),
    ).toMatchObject({ kind: 'both-kept', newContent: 'A ours\n\nA theirs\n' });
  });

  test('CRLF documents keep CRLF in both versions and between them', () => {
    expect(
      reconcile({
        docName,
        base: '# T\r\n\r\nP.\r\n\r\nQ.\r\n',
        ours: '# T\r\n\r\nP ours.\r\n\r\nQ.\r\n',
        theirs: '# T\r\n\r\nP theirs.\r\n\r\nQ.\r\n',
      }),
    ).toMatchObject({
      kind: 'both-kept',
      newContent: '# T\r\n\r\nP ours.\r\n\r\nP theirs.\r\n\r\nQ.\r\n',
    });
  });

  test('a block ours deleted and theirs changed restores the outside version in place, landed as theirs only', () => {
    expect(
      reconcile({
        docName,
        base: 'A\n\nB\n\nC\n',
        ours: 'A\n\nC\n',
        theirs: 'A\n\nB theirs\n\nC\n',
      }),
    ).toEqual({
      kind: 'both-kept',
      newContent: 'A\n\nB theirs\n\nC\n',
      kept: [{ blockIndex: 1, base: 'B', ours: '', theirs: 'B theirs', landed: 'theirs' }],
    });
  });

  test('a block ours changed and theirs deleted keeps the version here, landed as ours only', () => {
    expect(
      reconcile({
        docName,
        base: 'A\n\nB\n\nC\n',
        ours: 'A\n\nB ours\n\nC\n',
        theirs: 'A\n\nC\n',
      }),
    ).toEqual({
      kind: 'both-kept',
      newContent: 'A\n\nB ours\n\nC\n',
      kept: [{ blockIndex: 1, base: 'B', ours: 'B ours', theirs: '', landed: 'ours' }],
    });
  });

  test('only blocks that landed as both versions count as kept twice', () => {
    const outcome = reconcile({
      docName,
      base: 'A\n\nB\n\nC\n\nD\n',
      ours: 'A ours\n\nC\n\nD ours\n',
      theirs: 'A theirs\n\nB theirs\n\nC\n\nD\n',
    });
    expect(outcome).toMatchObject({
      kind: 'both-kept',
      newContent: 'A ours\n\nA theirs\n\nB theirs\n\nC\n\nD ours\n',
    });
    if (outcome.kind !== 'both-kept') return;
    expect(outcome.kept.map((pair) => pair.landed)).toEqual(['both', 'theirs']);
    expect(countKeptBlocks(outcome.kept).duplicated).toBe(1);
  });

  test("the check accepts both versions and refuses an output that drops or alters theirs' version", () => {
    const sides = {
      ...cleanMerge,
      base: 'A\n\nB\n\nC\n',
      ours: 'A\n\nB ours\n\nC\n',
      theirs: 'A\n\nB theirs\n\nC\n',
    };
    expect(checkMergeOutput({ ...sides, newContent: 'A\n\nB ours\n\nB theirs\n\nC\n' })).toBeNull();
    expect(checkMergeOutput({ ...sides, newContent: 'A\n\nB ours\n\nC\n' })).toEqual({
      check: 'side-bytes',
      side: 'theirs',
      sideBlockIndex: 1,
    });
    expect(checkMergeOutput({ ...sides, newContent: 'A\n\nB ours\n\nB  theirs\n\nC\n' })).toEqual({
      check: 'side-bytes',
      side: 'theirs',
      sideBlockIndex: 1,
    });
  });
});

describe('checkMergeOutput', () => {
  const base = 'Intro.\n\n    code\n\nAfter.\n';
  const ours = 'Intro.\n\n    code\n\nAfter.\n\n- new item\n';
  const theirs = 'Intro.\n\n    code\n\nAfter EDITED.\n';

  test('accepts the merge reconcile produces', () => {
    const outcome = reconcile({ docName, base, ours, theirs });
    expect(outcome).toMatchObject({
      kind: 'merged',
      newContent: 'Intro.\n\n    code\n\nAfter EDITED.\n\n- new item\n',
    });
    expect(
      checkMergeOutput({
        ...cleanMerge,
        base,
        ours,
        theirs,
        newContent: 'Intro.\n\n    code\n\nAfter EDITED.\n\n- new item\n',
      }),
    ).toBeNull();
  });

  test('refuses a duplicated block', () => {
    expect(
      checkMergeOutput({
        ...cleanMerge,
        base,
        ours,
        theirs,
        newContent: 'Intro.\n\n    code\n\nAfter EDITED.\n\n- new item\n\n- new item\n',
      }),
    ).toEqual({ check: 'single-occurrence', outputBlockIndex: 4 });
  });

  test('refuses a respelled untouched block', () => {
    expect(
      checkMergeOutput({
        ...cleanMerge,
        base,
        ours,
        theirs,
        newContent: 'Intro.\n\ncode\n\nAfter EDITED.\n\n- new item\n',
      }),
    ).toEqual({ check: 'untouched-verbatim', baseBlockIndex: 1 });
  });

  test('refuses an untouched block whose line endings were respelled without a whole-file conversion', () => {
    expect(
      checkMergeOutput({
        ...cleanMerge,
        base: 'A.\r\nA2.\r\n\r\nB.\r\n',
        ours: 'A.\r\nA2.\r\n\r\nB ours.\r\n',
        theirs: 'A.\r\nA2.\r\n\r\nB ours.\r\n\r\nC.\r\n',
        newContent: 'A.\nA2.\r\n\r\nB ours.\r\n\r\nC.\r\n',
      }),
    ).toEqual({ check: 'untouched-verbatim', baseBlockIndex: 0 });
  });

  test('refuses a side block that lost bytes', () => {
    expect(
      checkMergeOutput({
        ...cleanMerge,
        base: 'A.\n\nB.\n',
        ours: 'A.\n\nLine one  \nLine two\n',
        theirs: 'A theirs.\n\nB.\n',
        newContent: 'A theirs.\n\nLine one\nLine two\n',
      }),
    ).toEqual({ check: 'side-bytes', side: 'ours', sideBlockIndex: 1 });
  });

  test('refuses a side block that is missing', () => {
    expect(
      checkMergeOutput({
        ...cleanMerge,
        base,
        ours,
        theirs,
        newContent: 'Intro.\n\n    code\n\nAfter EDITED.\n',
      }),
    ).toEqual({ check: 'side-bytes', side: 'ours', sideBlockIndex: 3 });
  });

  test('refuses an output whose blocks are all faithful but one now parses as a different construct', () => {
    expect(
      checkMergeOutput({
        ...cleanMerge,
        base,
        ours,
        theirs,
        newContent: 'Intro.\n\n- new item\n\n    code\n\nAfter EDITED.\n',
      }),
    ).toEqual({ check: 'construct', outputBlockIndex: 2 });
  });
});

describe('documents the strict parse rejects', () => {
  test('an unparseable block nobody touched does not stop an ordinary merge', () => {
    const outcome = reconcile({
      docName,
      base: '# T\n\nA.\n\n<Foo>broken</Bar>\n\nB.\n',
      ours: '# T\n\nA ours.\n\n<Foo>broken</Bar>\n\nB.\n',
      theirs: '# T\n\nA.\n\n<Foo>broken</Bar>\n\nB theirs.\n',
    });
    expect(outcome).toEqual({
      kind: 'merged',
      newContent: '# T\n\nA ours.\n\n<Foo>broken</Bar>\n\nB theirs.\n',
      mergedBlocks: 4,
    });
  });

  test('an output that fails to parse when every source parses is refused as a parse failure', () => {
    expect(
      checkMergeOutput({
        ...cleanMerge,
        base: 'A\n\nB\n',
        ours: 'A\n\n<Foo>\n\nB\n\n</Foo>\n',
        theirs: 'A\n\nB theirs\n',
        newContent: 'A\n\n</Foo>\n\nB theirs\n\n<Foo>\n',
      }),
    ).toEqual({ check: 'parse' });
  });
});

describe('a skipped construct check is counted once per merge', () => {
  test('a source the strict parse rejects counts one skip; an ordinary merge counts none', () => {
    const before = getMetrics().reconcileConstructCheckSkipped;
    reconcile({ docName, base: 'A\n\nB\n', ours: 'A ours\n\nB\n', theirs: 'A\n\nB theirs\n' });
    expect(getMetrics().reconcileConstructCheckSkipped).toBe(before);
    reconcile({
      docName,
      base: '# T\n\nA.\n\n<Foo>broken</Bar>\n\nB.\n',
      ours: '# T\n\nA ours.\n\n<Foo>broken</Bar>\n\nB.\n',
      theirs: '# T\n\nA.\n\n<Foo>broken</Bar>\n\nB theirs.\n',
    });
    expect(getMetrics().reconcileConstructCheckSkipped).toBe(before + 1);
  });

  test('an oversized merge counts one skip', () => {
    const padding = 'Filler words. '.repeat(Math.ceil((MAX_CONSTRUCT_CHECK_BYTES + 1024) / 14));
    const before = getMetrics().reconcileConstructCheckSkipped;
    const outcome = reconcile({
      docName,
      base: `${padding}\n\nA\n\nB\n`,
      ours: `${padding}\n\nA ours\n\nB\n`,
      theirs: `${padding}\n\nA\n\nB theirs\n`,
    });
    expect(outcome.kind).toBe('merged');
    expect(getMetrics().reconcileConstructCheckSkipped).toBe(before + 1);
  });
});

describe('the construct check size bound', () => {
  const filler = (bytes: number): string => 'Filler words. '.repeat(Math.ceil(bytes / 14));
  const shape = (padding: string) => ({
    ...cleanMerge,
    base: `${padding}\n\nIntro.\n\n    code\n\nAfter.\n`,
    ours: `${padding}\n\nIntro.\n\n    code\n\nAfter.\n\n- new item\n`,
    theirs: `${padding}\n\nIntro.\n\n    code\n\nAfter EDITED.\n`,
    newContent: `${padding}\n\nIntro.\n\n- new item\n\n    code\n\nAfter EDITED.\n`,
  });

  test('a construct-changing output under the bound is refused', () => {
    expect(checkMergeOutput(shape(filler(1024)))).toEqual({
      check: 'construct',
      outputBlockIndex: 3,
    });
  });

  test('the same output over the bound is not refused, since only the byte checks run', () => {
    expect(checkMergeOutput(shape(filler(MAX_CONSTRUCT_CHECK_BYTES + 1024)))).toBeNull();
  });
});
