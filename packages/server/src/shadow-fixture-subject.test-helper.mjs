import { Worker } from 'node:worker_threads';

const worker = new Worker(
  `
  const { execFileSync, spawn } = require('node:child_process');
  const { appendFileSync, mkdtempSync, rmSync, writeFileSync } = require('node:fs');
  const { tmpdir } = require('node:os');
  const { join } = require('node:path');
  if (${JSON.stringify(process.argv[2])} === 'async-hold') {
    const child = spawn('git', ['hash-object', '--stdin']);
    child.on('error', (error) => { throw error; });
  } else if (${JSON.stringify(process.argv[2])} === 'unsupported-node') {
    void (async () => {
      const child = spawn('git', ['hash-object', '--stdin']);
      child.on('error', (error) => { throw error; });
      await new Promise((resolve) => child.on('spawn', resolve));
      spawn(process.execPath, ['--eval', 'process.exit(0)']);
    })().catch((error) => { throw error; });
  } else if (${JSON.stringify(process.argv[2])} === 'sync-hold') {
    execFileSync('git', ['hash-object', '--stdin'], { timeout: 60_000 });
  } else if (${JSON.stringify(process.argv[2])} === 'termination') {
    void (async () => {
      let timeout;
      try { execFileSync('git', ['hash-object', '--stdin'], { timeout: 80, killSignal: 'SIGTERM' }); }
      catch (error) { timeout = { code: error.code, status: error.status, signal: error.signal }; }
      appendFileSync(process.env.OK_SHADOW_SUBJECT_RESULT + '.stages', 'timeout observed\\n');
      const child = spawn('git', ['hash-object', '--stdin']);
      child.on('error', (error) => { throw error; });
      const closed = new Promise((resolve) => child.on('close', (code, signal) => {
        appendFileSync(process.env.OK_SHADOW_SUBJECT_RESULT + '.stages', 'close observed\\n');
        resolve({ code, signal });
      }));
      await new Promise((resolve) => child.on('spawn', resolve));
      appendFileSync(process.env.OK_SHADOW_SUBJECT_RESULT + '.stages', 'spawn observed\\n');
      const signaled = child.kill('SIGTERM');
      writeFileSync(process.env.OK_SHADOW_SUBJECT_RESULT, JSON.stringify({ timeout, signaled, closed: await closed }));
    })().catch((error) => { throw error; });
  } else if (${JSON.stringify(process.argv[2])} === 'conformance') {
    void (async () => {
      const root = mkdtempSync(join(tmpdir(), 'native-git-'));
      try {
        const git = (args) => execFileSync('git', args, { cwd: root, timeout: 10_000 });
        git(['init', '--initial-branch=main', '--object-format=sha1']);
        git(['config', '--local', 'maintenance.auto', 'false']);
        writeFileSync(join(root, 'note.md'), '# Note\\n');
        writeFileSync(join(root, 'line\\nname.md'), '# Line\\n');
        git(['add', '-A']);
        const listed = git(['ls-files', '-z']);
        const input = Buffer.from([65, 0, 66, 10, 255]);
        const child = spawn('git', ['hash-object', '--stdin'], { cwd: root });
        const output = [];
        child.stdout.on('data', (data) => output.push(data));
        const completed = new Promise((resolve, reject) => {
          child.on('error', reject);
          child.on('close', (code, signal) => resolve({ code, signal }));
        });
        child.stdin.end(input);
        const closed = await completed;
        let rejected;
        try { git(['rev-parse', '--verify', 'refs/heads/missing']); }
        catch (error) { rejected = { status: error.status, signal: error.signal, stderr: error.stderr.toString() }; }
        writeFileSync(process.env.OK_SHADOW_SUBJECT_RESULT, JSON.stringify({
          listed: listed.toString('base64'), output: Buffer.concat(output).toString(), closed, rejected,
        }));
      } finally { rmSync(root, { recursive: true, force: true }); }
    })().catch((error) => { throw error; });
  } else {
    const output = execFileSync('git', ['--version'], { encoding: 'utf8', timeout: 10_000 });
    writeFileSync(process.env.OK_SHADOW_SUBJECT_RESULT, JSON.stringify({ output }));
  }
`,
  { eval: true },
);
worker.on('error', (error) => {
  process.stderr.write(String(error));
  process.exitCode = 1;
});
