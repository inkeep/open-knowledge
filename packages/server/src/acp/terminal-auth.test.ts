import { expect, test } from 'vitest';
import { terminalAuthBaseFor, terminalAuthLaunch, threadAuthMethods } from './terminal-auth.ts';

const PROCESS_ENV = { PATH: '/usr/bin', HOME: '/Users/me', LANG: 'en_US.UTF-8' };
const NUL = String.fromCharCode(0);

const MANAGED_NPX = {
  cmd: '/Users/me/.ok/runtimes/cache/node/node-v24/bin/npx',
  args: ['-y', '@augmentcode/auggie@1.2.3', '--acp'],
  env: { ...PROCESS_ENV, PATH: '/Users/me/.ok/runtimes/cache/node/node-v24/bin:/usr/bin' },
  kind: 'npx' as const,
};

const TERMINAL_METHODS = [
  {
    id: 'auggie-login',
    name: 'Log in with Auggie',
    description: 'Runs the login flow in a terminal.',
    type: 'terminal',
    args: ['login'],
    env: { AUGGIE_LOGIN_FLOW: 'terminal' },
  },
  { id: 'oauth', name: 'Sign in with Auggie', type: 'agent' },
  { id: 'token', name: 'API token', type: 'env_var', vars: [{ name: 'AUGGIE_TOKEN' }] },
] as never;

test('a managed-runtime launch puts its bin directory ahead of the terminal PATH', () => {
  expect(terminalAuthBaseFor(MANAGED_NPX, PROCESS_ENV)).toEqual({
    executable: MANAGED_NPX.cmd,
    args: ['-y', '@augmentcode/auggie@1.2.3', '--acp'],
    env: {},
    pathPrepend: ['/Users/me/.ok/runtimes/cache/node/node-v24/bin'],
  });
});

test('only the agent overlay survives into the launch env, never the inherited process env or PATH', () => {
  const base = terminalAuthBaseFor(
    {
      cmd: 'auggie',
      args: ['--acp'],
      env: {
        ...PROCESS_ENV,
        PATH: '/opt/agent/bin:/usr/bin',
        AUGGIE_HOME: '/Users/me/.auggie',
        npm_config_cache: '/Users/me/.ok/runtimes/cache/npm',
        'BAD NAME': 'dropped',
        BAD_VALUE: `x${NUL}y`,
      },
      kind: 'custom',
    },
    PROCESS_ENV,
  );
  expect(base).toEqual({
    executable: 'auggie',
    args: ['--acp'],
    env: { AUGGIE_HOME: '/Users/me/.auggie', npm_config_cache: '/Users/me/.ok/runtimes/cache/npm' },
    pathPrepend: [],
  });
});

test('the persisted method only says that a terminal launch exists', () => {
  const base = terminalAuthBaseFor(
    { cmd: 'auggie', args: ['--acp'], env: { ...PROCESS_ENV, AUGGIE_HOME: '/x' }, kind: 'custom' },
    PROCESS_ENV,
  );
  expect(threadAuthMethods(TERMINAL_METHODS, base)).toEqual([
    {
      id: 'auggie-login',
      name: 'Log in with Auggie',
      description: 'Runs the login flow in a terminal.',
      kind: 'terminal',
      terminalLaunchAvailable: true,
    },
    { id: 'oauth', name: 'Sign in with Auggie', kind: 'agent' },
    { id: 'token', name: 'API token', kind: 'env_var' },
  ]);
  expect(JSON.stringify(threadAuthMethods(TERMINAL_METHODS, base))).not.toContain('/x');
  expect(JSON.stringify(threadAuthMethods(TERMINAL_METHODS, base))).not.toContain('--acp');
});

test('the live launch carries the agent overlay and the method env', () => {
  const base = terminalAuthBaseFor(
    { cmd: 'auggie', args: ['--acp'], env: { ...PROCESS_ENV, AUGGIE_HOME: '/x' }, kind: 'custom' },
    PROCESS_ENV,
  );
  expect(terminalAuthLaunch(TERMINAL_METHODS, base, 'auggie-login')).toEqual({
    executable: 'auggie',
    args: ['--acp', 'login'],
    env: { AUGGIE_HOME: '/x', AUGGIE_LOGIN_FLOW: 'terminal' },
    pathPrepend: [],
  });
  expect(terminalAuthLaunch(TERMINAL_METHODS, base, 'oauth')).toBeNull();
  expect(terminalAuthLaunch(TERMINAL_METHODS, base, 'missing')).toBeNull();
  expect(terminalAuthLaunch(TERMINAL_METHODS, null, 'auggie-login')).toBeNull();
});

test('hostile env names and NUL values from the method are dropped', () => {
  const base = terminalAuthBaseFor(
    { cmd: 'agent', args: [], env: PROCESS_ENV, kind: 'binary' },
    PROCESS_ENV,
  );
  const methods = [
    {
      id: 'cli',
      name: 'CLI',
      type: 'terminal',
      env: {
        'X; Start-Process calc; $y': '1',
        '--split-string': 'evil',
        'A-B': '1',
        OK_TERMINAL_LAUNCH_ENV_0: 'reserved for the launch itself',
        ok_terminal_launch_env_1: 'the same slot on a case-folding shell',
        OK_NAME: 'kept',
        WITH_NUL: `a${NUL}b`,
      },
    },
  ] as never;
  expect(terminalAuthLaunch(methods, base, 'cli')?.env).toEqual({ OK_NAME: 'kept' });
});

test('a terminal method without a known launch stays a description', () => {
  expect(
    threadAuthMethods(
      [{ id: 'cli', name: 'CLI login', type: 'terminal', args: ['login'] }] as never,
      null,
    ),
  ).toEqual([{ id: 'cli', name: 'CLI login', kind: 'terminal' }]);
});

test('malformed method entries and non-string fields are dropped', () => {
  expect(
    threadAuthMethods(
      [
        null,
        { id: 7, name: 'x' },
        { id: 'ok', name: 'Fine', type: 'terminal', args: ['login', 3] },
      ] as never,
      terminalAuthBaseFor(
        { cmd: 'agent', args: [], env: PROCESS_ENV, kind: 'binary' },
        PROCESS_ENV,
      ),
    ),
  ).toEqual([
    {
      id: 'ok',
      name: 'Fine',
      kind: 'terminal',
      terminalLaunchAvailable: true,
    },
  ]);
});
