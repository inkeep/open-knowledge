import { excludeWorkingDirectoryFromProgramLookup } from '@inkeep/open-knowledge-core/util/windows-program-lookup';
import { createPtyPhaseTrace, installUtilityPtyPhaseTrace } from '../shared/pty-phase-trace.ts';

excludeWorkingDirectoryFromProgramLookup();
const utilityPhaseTrace = createPtyPhaseTrace(process.env, 'utility', (record) => {
  process.stderr.write(`${JSON.stringify(record)}\n`);
});

installUtilityPtyPhaseTrace(utilityPhaseTrace);
utilityPhaseTrace?.mark('utility-entry', 'point');
await import('./pty-host.ts');
