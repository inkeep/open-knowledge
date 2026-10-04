import {
  collectWindowsOsState,
  WINDOWS_OS_MAX_BUDGET_MS,
  WINDOWS_OS_MAX_RESULT_BYTES,
  WINDOWS_OS_MAX_TARGETS,
} from './windows-os-state.test-helper.ts';

function positive(value: string | undefined): number | null {
  if (value === undefined || !/^[1-9][0-9]*$/u.test(value)) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function boundedBudget(value: string | undefined): number | null {
  const number = positive(value);
  return number !== null && number <= WINDOWS_OS_MAX_BUDGET_MS ? number : null;
}

function emit(value: unknown, status: number): void {
  const serialized = JSON.stringify(value);
  const tooLarge = Buffer.byteLength(serialized) > WINDOWS_OS_MAX_RESULT_BYTES;
  const output = tooLarge
    ? JSON.stringify({ version: 1, status: 'unavailable', reason: 'output-limit' })
    : serialized;
  process.stdout.write(`${output}\n`);
  process.exitCode = tooLarge ? 1 : status;
}

const args = process.argv.slice(2);
const pids: number[] = [];
let parentPid: number | undefined;
let budgetMs = WINDOWS_OS_MAX_BUDGET_MS;
let valid = true;
for (let index = 0; index < args.length; index += 2) {
  const flag = args[index];
  const value = args[index + 1];
  if (flag === '--pid') {
    const pid = positive(value);
    if (pid === null || pids.length >= WINDOWS_OS_MAX_TARGETS) {
      valid = false;
      break;
    }
    pids.push(pid);
  } else if (flag === '--parent-pid' && parentPid === undefined) {
    const pid = positive(value);
    if (pid === null) {
      valid = false;
      break;
    }
    parentPid = pid;
  } else if (flag === '--budget-ms') {
    const budget = boundedBudget(value);
    if (budget === null) {
      valid = false;
      break;
    }
    budgetMs = budget;
  } else {
    valid = false;
    break;
  }
}

if (!valid || pids.length === 0 || args.length % 2 !== 0) {
  emit({ version: 1, status: 'unavailable', reason: 'invalid-shape' }, 2);
} else {
  const deadlineAt = performance.now() + budgetMs;
  const firstPid = pids[0];
  if (firstPid === undefined) {
    emit({ version: 1, status: 'unavailable', reason: 'invalid-shape' }, 2);
  } else {
    const observation = await collectWindowsOsState({
      pid: firstPid,
      additionalPids: pids.slice(1),
      parentPid,
      deadlineAt,
    });
    const success =
      observation.machine.status === 'captured' &&
      observation.targets.length === pids.length &&
      observation.targets.every((target) => target.shell.status === 'captured');
    emit(observation, success ? 0 : 1);
  }
}
