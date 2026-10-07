import { execFileSync as unboundedExecFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';

export const CHILD_TRIPWIRE_CODE = 'ECHILD_TRIPWIRE';
export const CHILD_TRIPWIRE_OPEN_CODE = 'ECHILD_TRIPWIRE_OPEN';
export const STRUCTURAL_FOLLOW_UP =
  'Structural follow-up: run these children through an asynchronous spawn whose watchdog bounds the ' +
  "time without output and stops the child's own process group, which a synchronous spawn cannot do.";

const INTERIM_CHILD_TRIPWIRE_MS = 20_000;
const COMMAND_LINE_CHARS = 400;
const OUTPUT_TAIL_CHARS = 2000;

const commandLineOf = (file, args) => {
  const line = [file, ...args].map(String).join(' ');
  return line.length > COMMAND_LINE_CHARS ? `${line.slice(0, COMMAND_LINE_CHARS)}...` : line;
};

const tailOf = (output) => {
  if (output === undefined || output === null) return String(output);
  const text = Buffer.isBuffer(output) ? output.toString('utf8') : String(output);
  return JSON.stringify(
    text.length > OUTPUT_TAIL_CHARS ? `...${text.slice(-OUTPUT_TAIL_CHARS)}` : text,
  );
};

const howItEnded = (error) =>
  error.status === null
    ? `It was killed (pid ${error.pid}, signal=${error.signal}).`
    : `It had itself exited with status ${error.status}, but a descendant kept its stdout or stderr ` +
      'open, so this harness closed its own ends of those pipes.';

export function createChildTripwire({ boundMs = INTERIM_CHILD_TRIPWIRE_MS } = {}) {
  let blockedChild = null;
  return function execFileSync(file, args, options) {
    const argv = Array.isArray(args) ? args : [];
    const execOptions = (Array.isArray(args) || args == null ? options : args) ?? {};
    const commandLine = commandLineOf(file, argv);
    if ('timeout' in execOptions || 'killSignal' in execOptions) {
      throw new TypeError(
        `This execFileSync owns the timeout and the kill signal, and \`${commandLine}\` passed its ` +
          'own. Use node:child_process directly for a child whose expiry the test itself observes.',
      );
    }
    if (blockedChild !== null) {
      const refusal = new Error(
        `Not starting \`${commandLine}\`: an earlier child in this test file, ${blockedChild}, was ` +
          `still running at the ${boundMs} ms tripwire. A host that blocks one child tends to block the ` +
          'next (the bash here-document deadlock blocked every here-document over 512 bytes while it ' +
          `lasted), and each further child would cost another ${boundMs} ms and could leave another ` +
          'blocked descendant behind, so this file starts no more children. Diagnose the first ' +
          'failure, then run the tests again.',
      );
      refusal.code = CHILD_TRIPWIRE_OPEN_CODE;
      throw refusal;
    }
    const started = performance.now();
    try {
      return unboundedExecFileSync(file, argv, {
        ...execOptions,
        timeout: boundMs,
        killSignal: 'SIGKILL',
      });
    } catch (error) {
      if (error?.code !== 'ETIMEDOUT') throw error;
      const elapsedMs = Math.round(performance.now() - started);
      blockedChild = `\`${commandLine}\` (pid ${error.pid})`;
      const diagnosis = new Error(
        `\`${commandLine}\` was still holding this test ${elapsedMs} ms after it started, past the ` +
          `interim ${boundMs} ms child tripwire, so the test failed instead of the tier waiting on it ` +
          `forever. ${howItEnded(error)} Captured before the bound: stdout=${tailOf(error.stdout)} ` +
          `stderr=${tailOf(error.stderr)}. No healthy child in this file comes near this bound, so one ` +
          'still running here is blocked rather than slow. The case the tripwire was added for is ' +
          'Homebrew bash 5.3.9, whose here-document write deadlocks when the kernel hands it a 512-byte ' +
          'pipe; bash 5.3.16 and later fix it, so check `bash --version` first. Descendants were not ' +
          'signalled, because this harness signals only the process it spawned, so any it left blocked ' +
          'keeps running after this test. The bound measures elapsed time because a synchronous spawn ' +
          `cannot observe progress. ${STRUCTURAL_FOLLOW_UP}`,
      );
      diagnosis.code = CHILD_TRIPWIRE_CODE;
      throw diagnosis;
    }
  };
}

export const execFileSync = createChildTripwire();
