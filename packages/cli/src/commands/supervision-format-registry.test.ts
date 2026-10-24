import { Command } from 'commander';
import { describe, expect, test, vi } from 'vitest';
import { cleanCommand } from './clean.ts';
import { psCommand } from './ps.ts';
import { statusCommand } from './status.ts';
import { stopCommand } from './stop.ts';
import {
  type SupervisionContext,
  SupervisionFormatRegistry,
  type SupervisionFormatStrategy,
} from './supervision-format-registry.ts';
import { jsonV1Strategy } from './supervision-json-v1-strategy.ts';

const context: SupervisionContext = {
  project: { root: '/example/project', resolution: 'cwd' },
  failure: 'alternate setup failure',
};

describe('supervision format registry', () => {
  test('selects the registered strategy and its setup policy', () => {
    const alternate: SupervisionFormatStrategy = {
      format: 'json-test',
      requiresProjectConfig: (command) => command === 'clean',
      execute: async () => ({ document: { format: 'test' }, exitCode: 0 }),
    };
    const registry = new SupervisionFormatRegistry([jsonV1Strategy, alternate]);

    expect(registry.select('clean', 'json-test')?.strategy.requiresProjectConfig('clean', [])).toBe(
      true,
    );
    expect(registry.select('ps', 'json-test')?.strategy.requiresProjectConfig('ps', [])).toBe(
      false,
    );
    expect(registry.select('start', 'json-test')).toBeUndefined();
    expect(registry.select('clean', 'unknown')).toBeUndefined();
    expect(() => new SupervisionFormatRegistry([alternate, alternate])).toThrow(/duplicate/);
  });

  test.each([
    { command: 'status', args: [] },
    { command: 'ps', args: ['all'] },
    { command: 'stop', args: ['all', '--force'] },
    { command: 'clean', args: [] },
  ] as const)(
    '$command dispatches an alternate document through the shared writer',
    async ({ command, args }) => {
      const bytes: string[] = [];
      const setExitCode = vi.fn();
      const execute = vi.fn<SupervisionFormatStrategy['execute']>(async (request) => ({
        document: { format: 'test', request },
        exitCode: 1,
      }));
      const registry = new SupervisionFormatRegistry(
        [jsonV1Strategy, { format: 'json-test', requiresProjectConfig: () => false, execute }],
        {
          write: (buffer, offset) => {
            const slice = Buffer.from(buffer).subarray(offset);
            bytes.push(slice.toString('utf8'));
            return slice.length;
          },
          setExitCode,
        },
      );
      const getConfig = () => {
        throw new Error('legacy config must not be loaded');
      };
      const root = new Command();
      const selected =
        command === 'status'
          ? statusCommand(getConfig, () => context, registry)
          : command === 'ps'
            ? psCommand(() => context.failure, registry)
            : command === 'stop'
              ? stopCommand(getConfig, () => context, registry)
              : cleanCommand(getConfig, () => context, registry);
      root.addCommand(selected);

      await root.parseAsync([command, ...args, '--format=json-test'], { from: 'user' });

      expect(execute).toHaveBeenCalledOnce();
      const document = JSON.parse(bytes.join(''));
      expect(document).toMatchObject({
        format: 'test',
        request: { command, context: { failure: context.failure } },
      });
      expect(bytes.join('')).toBe(`${JSON.stringify(document)}\n`);
      expect(setExitCode).toHaveBeenCalledWith(1);
    },
  );
});
