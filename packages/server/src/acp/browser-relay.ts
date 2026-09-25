import type * as ChildProcessModule from 'node:child_process';
import type * as UrlModule from 'node:url';

type Json = Record<string, unknown>;

export function runBrowserRelay(
  childProcess: typeof ChildProcessModule,
  url: typeof UrlModule,
  allowedToolNames: readonly string[],
): void {
  const [cwd, filesDir, command, ...args] = process.argv.slice(1);
  if (cwd === undefined || filesDir === undefined || command === undefined) {
    process.stderr.write('ok-browser relay: missing the folder, files or command argument\n');
    process.exit(2);
  }
  const allowed = new Set(allowedToolNames);
  const roots = { roots: [{ uri: url.pathToFileURL(filesDir).href, name: 'chat files' }] };
  const child = childProcess.spawn(command, args, {
    cwd,
    stdio: ['pipe', 'pipe', 'inherit'],
    windowsHide: true,
  });
  const input = child.stdin;
  const output = child.stdout;
  if (input === null || output === null) {
    process.stderr.write('ok-browser relay: the browser server has no pipes\n');
    process.exit(1);
  }
  const record = (value: unknown): Json | null =>
    value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : null;
  const toServer = (message: unknown): void => {
    input.write(`${JSON.stringify(message)}\n`);
  };
  const toClient = (message: unknown): void => {
    process.stdout.write(`${JSON.stringify(message)}\n`);
  };
  const drop = (side: string, reason: string): void => {
    process.stderr.write(`ok-browser relay: dropped a ${side} line that ${reason}\n`);
  };
  const single = (line: string, side: string, answer: (message: unknown) => void): Json | null => {
    if (line.trim() === '') return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      drop(side, 'is not JSON');
      return null;
    }
    const message = record(parsed);
    if (message !== null) return message;
    if (Array.isArray(parsed)) {
      for (const item of parsed) {
        const entry = record(item);
        if (entry?.method !== undefined && entry.id !== undefined) {
          answer({
            jsonrpc: '2.0',
            id: entry.id,
            error: { code: -32600, message: 'Batched messages are not supported' },
          });
        }
      }
    }
    drop(side, 'is not a single JSON-RPC message');
    return null;
  };
  const fromClient = (line: string): string | null => {
    const message = single(line, 'client', toClient);
    if (message === null) return null;
    if (message.method === 'notifications/roots/list_changed') return null;
    const params = record(message.params);
    const tool = params?.name;
    if (message.method === 'tools/call' && (typeof tool !== 'string' || !allowed.has(tool))) {
      if (message.id !== undefined) {
        toClient({
          jsonrpc: '2.0',
          id: message.id,
          error: { code: -32602, message: `Tool ${String(tool)} is not available` },
        });
      }
      return null;
    }
    if (message.method === 'initialize' && params !== null) {
      params.capabilities = { ...record(params.capabilities), roots: { listChanged: false } };
    }
    return JSON.stringify(message);
  };
  const fromServer = (line: string): string | null => {
    const message = single(line, 'server', toServer);
    if (message === null) return null;
    if (message.method === 'roots/list') {
      if (message.id !== undefined) toServer({ jsonrpc: '2.0', id: message.id, result: roots });
      return null;
    }
    const result = record(message.result);
    const tools = result?.tools;
    if (result === null || !Array.isArray(tools)) return line;
    const kept = tools.filter((entry) => {
      const name = record(entry)?.name;
      return typeof name === 'string' && allowed.has(name);
    });
    for (const entry of kept) {
      const annotations = record(record(entry)?.annotations);
      if (annotations !== null) annotations.readOnlyHint = false;
    }
    result.tools = kept;
    return JSON.stringify(message);
  };
  const relay = (
    from: NodeJS.ReadableStream,
    to: NodeJS.WritableStream,
    rewrite: (line: string) => string | null,
    end: boolean,
  ): void => {
    let pending = '';
    const emit = (line: string): void => {
      const out = rewrite(line);
      if (out !== null) to.write(`${out}\n`);
    };
    from.setEncoding('utf8');
    from.on('data', (chunk: string | Buffer) => {
      pending += String(chunk);
      let at = pending.indexOf('\n');
      while (at !== -1) {
        emit(pending.slice(0, at));
        pending = pending.slice(at + 1);
        at = pending.indexOf('\n');
      }
    });
    from.on('end', () => {
      if (pending !== '') emit(pending);
      if (end) to.end();
    });
  };
  input.on('error', () => {});
  relay(process.stdin, input, fromClient, true);
  relay(output, process.stdout, fromServer, false);
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.on(signal, () => child.kill());
  }
  child.on('error', (err) => {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  });
  child.on('close', (code) => {
    process.exitCode = code ?? 1;
    process.stdin.destroy();
  });
}
