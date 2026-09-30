import type { PtyStartupTraceOptions } from '../../src/utility/pty-host.ts';
import type { PtyHostProbeOptions } from './pty-readiness.test-helper.ts';

type ProbeStartupTrace = PtyHostProbeOptions['startupTrace'];
declare const aroundSpawn: NonNullable<PtyStartupTraceOptions['aroundSpawn']>;

const _noTrace: ProbeStartupTrace = {};
void _noTrace;
const _nativeOff: ProbeStartupTrace = { native: false };
void _nativeOff;
const _callerHook: ProbeStartupTrace = { aroundSpawn };
void _callerHook;

// @ts-expect-error -- native selects the built-in Windows observer, so a caller aroundSpawn beside it would be silently dropped.
const _nativeWithHook: ProbeStartupTrace = { native: true, aroundSpawn };
void _nativeWithHook;

const _builtElsewhere = { native: true, aroundSpawn };
// @ts-expect-error -- the exclusivity must hold through a widened variable, where excess-property checking does not fire; the `?: never` arms are what reject it.
const _widenedNativeWithHook: ProbeStartupTrace = _builtElsewhere;
void _widenedNativeWithHook;
