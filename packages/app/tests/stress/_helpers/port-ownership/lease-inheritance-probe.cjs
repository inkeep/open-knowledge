const childProcess = require('node:child_process');
const { once } = require('node:events');
const { writeSync } = require('node:fs');

const key = 'OK_PORT_OWNERSHIP_LEASE_FD';
const [role, label] = process.argv.slice(2);
const writeLabel = (name) => writeSync(Number(process.env[key]), `${name}\n`);
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;

async function observe(name, child) {
  let stdout = '';
  let message;
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.pipe(process.stderr, { end: false });
  child.on('message', (value) => {
    message = value;
  });
  try {
    const [code, signal] = await once(child, 'close');
    return { label: name, code, signal, stdioLength: child.stdio.length, stdout, message };
  } catch (error) {
    return { label: name, error: String(error) };
  }
}

function observeSync(name, run) {
  try {
    return { label: name, code: 0, signal: null, stdout: run() };
  } catch (error) {
    return {
      label: name,
      code: error.status ?? null,
      signal: error.signal ?? null,
      stdout: String(error.stdout ?? ''),
      error: String(error),
    };
  }
}

async function drive() {
  const env = { PATH: process.env.PATH, NODE_OPTIONS: process.env.NODE_OPTIONS };
  const actor = (name) => [__filename, 'actor', name];
  const command = (name) => [process.execPath, ...actor(name)].map(quote).join(' ');
  const routes = [
    await observe('spawn', childProcess.spawn(process.execPath, actor('spawn'), { env })),
    await observe('fork', childProcess.fork(__filename, ['actor', 'fork'], { env, silent: true })),
    await observe('execFile', childProcess.execFile(process.execPath, actor('execFile'), { env })),
    await observe('exec', childProcess.exec(command('exec'), { env })),
  ];
  const sync = childProcess.spawnSync(process.execPath, actor('spawnSync'), {
    env,
    encoding: 'utf8',
  });
  process.stderr.write(sync.stderr ?? '');
  routes.push(
    {
      label: 'spawnSync',
      code: sync.status,
      signal: sync.signal,
      stdioLength: sync.output?.length,
      stdout: sync.stdout,
      error: sync.error ? String(sync.error) : undefined,
    },
    observeSync('execFileSync', () =>
      childProcess.execFileSync(process.execPath, actor('execFileSync'), {
        env,
        encoding: 'utf8',
      }),
    ),
    observeSync('execSync', () =>
      childProcess.execSync(command('execSync'), { env, encoding: 'utf8' }),
    ),
  );
  process.once('message', () => {
    writeLabel('after-owner-release');
    process.disconnect();
  });
  process.send({ routes });
}

if (role === 'actor') {
  writeLabel(label);
  process.stdout.write(`${label}\n`);
  if (process.send) process.send(label, () => process.disconnect());
} else if (role === 'driver') {
  void drive();
} else if (role === 'reader') {
  process.stdin.pipe(process.stdout);
} else {
  throw new Error(`unknown lease probe role: ${role}`);
}
