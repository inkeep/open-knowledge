import { describe, expect, test } from 'vitest';
import { rowActionFor, rowHasResidualFiles } from './agent-row-action';

const CONFIGURABLE = { presence: 'present', configurable: true, setupDocSlug: null } as const;

describe('rowActionFor', () => {
  test('an enabled row with nothing installed offers to connect', () => {
    expect(rowActionFor({ ...CONFIGURABLE, enabled: true, installedCount: 0 })).toEqual({
      kind: 'connect',
    });
  });

  test('an enabled row with something installed offers to manage it', () => {
    expect(rowActionFor({ ...CONFIGURABLE, enabled: true, installedCount: 2 })).toEqual({
      kind: 'manage',
    });
  });

  test('a disabled row with nothing installed offers no action', () => {
    expect(rowActionFor({ ...CONFIGURABLE, enabled: false, installedCount: 0 })).toEqual({
      kind: 'none',
    });
  });

  test('a disabled row with something installed offers to remove it', () => {
    expect(rowActionFor({ ...CONFIGURABLE, enabled: false, installedCount: 3 })).toEqual({
      kind: 'remove',
    });
  });

  test('a disabled row with only some parts installed still offers to remove them', () => {
    expect(rowActionFor({ ...CONFIGURABLE, enabled: false, installedCount: 1 })).toEqual({
      kind: 'remove',
    });
  });

  test('an absent tool the registry folds still points at its setup docs with files on disk', () => {
    const input = {
      enabled: false,
      installedCount: 1,
      presence: 'absent',
      configurable: true,
      setupDocSlug: 'claude-code',
    } as const;
    expect(rowActionFor(input)).toEqual({ kind: 'setup-doc', slug: 'claude-code' });
    expect(rowHasResidualFiles(input)).toBe(true);
  });

  test('an absent tool the registry folds points at its setup docs', () => {
    expect(
      rowActionFor({
        enabled: false,
        installedCount: 0,
        presence: 'absent',
        configurable: true,
        setupDocSlug: 'claude-code',
      }),
    ).toEqual({ kind: 'setup-doc', slug: 'claude-code' });
  });

  test('an absent tool the registry folds with no setup doc offers no action', () => {
    expect(
      rowActionFor({
        enabled: false,
        installedCount: 0,
        presence: 'absent',
        configurable: true,
        setupDocSlug: null,
      }),
    ).toEqual({ kind: 'none' });
  });

  test('a row with nothing OpenKnowledge can configure points at its setup docs', () => {
    expect(
      rowActionFor({
        enabled: true,
        installedCount: 0,
        presence: 'present',
        configurable: false,
        setupDocSlug: 'lm-studio',
      }),
    ).toEqual({ kind: 'setup-doc', slug: 'lm-studio' });
  });

  test('a connected row OpenKnowledge cannot configure still offers remove', () => {
    expect(
      rowActionFor({
        enabled: false,
        installedCount: 1,
        presence: 'present',
        configurable: false,
        setupDocSlug: 'lm-studio',
      }),
    ).toEqual({ kind: 'remove' });
  });

  test('a row with nothing configurable and no doc offers no action', () => {
    expect(
      rowActionFor({
        enabled: true,
        installedCount: 0,
        presence: 'present',
        configurable: false,
        setupDocSlug: null,
      }),
    ).toEqual({ kind: 'none' });
  });

  test('an absent tool points at its setup doc even when the registry keeps its row', () => {
    expect(
      rowActionFor({
        enabled: false,
        installedCount: 0,
        presence: 'absent',
        configurable: true,
        setupDocSlug: 'codex',
      }),
    ).toEqual({ kind: 'setup-doc', slug: 'codex' });
  });

  test('an absent tool with files still on disk keeps its doc as the primary action', () => {
    const input = {
      enabled: false,
      installedCount: 1,
      presence: 'absent',
      configurable: true,
      setupDocSlug: 'codex',
    } as const;
    expect(rowActionFor(input)).toEqual({ kind: 'setup-doc', slug: 'codex' });
    expect(rowHasResidualFiles(input)).toBe(true);
  });

  test('an absent tool with no doc still offers nothing', () => {
    expect(
      rowActionFor({
        enabled: false,
        installedCount: 0,
        presence: 'absent',
        configurable: true,
        setupDocSlug: null,
      }),
    ).toEqual({ kind: 'none' });
  });

  test('a probe that has not answered leaves a working row its action', () => {
    expect(
      rowActionFor({
        enabled: true,
        installedCount: 0,
        presence: 'unknown',
        configurable: true,
        setupDocSlug: 'codex',
      }),
    ).toEqual({ kind: 'connect' });
  });

  test('an absent tool offers where to get it, not how to wire it up', () => {
    expect(
      rowActionFor({
        enabled: false,
        installedCount: 0,
        presence: 'absent',
        configurable: true,
        setupDocSlug: 'codex',
        installUrl: 'https://developers.openai.com/codex/app',
      }),
    ).toEqual({ kind: 'install', url: 'https://developers.openai.com/codex/app' });
  });

  test('an absent tool with no install url falls back to its doc', () => {
    expect(
      rowActionFor({
        enabled: false,
        installedCount: 0,
        presence: 'absent',
        configurable: true,
        setupDocSlug: 'codex',
        installUrl: null,
      }),
    ).toEqual({ kind: 'setup-doc', slug: 'codex' });
  });

  test('the install link outranks cleanup, which moves beside the hint', () => {
    const input = {
      enabled: false,
      installedCount: 2,
      presence: 'absent',
      configurable: true,
      setupDocSlug: 'codex',
      installUrl: 'https://developers.openai.com/codex/app',
    } as const;
    expect(rowActionFor(input)).toEqual({
      kind: 'install',
      url: 'https://developers.openai.com/codex/app',
    });
    expect(rowHasResidualFiles(input)).toBe(true);
  });

  test('a present tool never reports residual files, however many parts it has', () => {
    expect(rowHasResidualFiles({ ...CONFIGURABLE, installedCount: 3 })).toBe(false);
  });

  test('an unresolved probe never reports residual files', () => {
    expect(rowHasResidualFiles({ installedCount: 2, presence: 'unknown' })).toBe(false);
  });

  test('an absent tool with nothing on disk has no cleanup to offer', () => {
    expect(rowHasResidualFiles({ installedCount: 0, presence: 'absent' })).toBe(false);
  });

  test('a present tool never offers to install it', () => {
    expect(
      rowActionFor({
        enabled: true,
        installedCount: 0,
        presence: 'present',
        configurable: true,
        setupDocSlug: 'codex',
        installUrl: 'https://developers.openai.com/codex/app',
      }),
    ).toEqual({ kind: 'connect' });
  });
});
