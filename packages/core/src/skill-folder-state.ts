import { lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';

interface SkillFolderIdentity {
  host: string;
  root: string;
}

export type SkillFolderState =
  | (SkillFolderIdentity & { state: 'absent' })
  | (SkillFolderIdentity & {
      state: 'own' | 'linked' | 'linked-parent';
      real: string;
      target?: string;
    });

export function scanSkillFolderStates(
  base: string,
  roots: ReadonlyArray<{ editor: string; root: string }>,
): SkillFolderState[] {
  let baseReal: string;
  try {
    baseReal = realpathSync(base);
  } catch {
    return roots.map(({ editor, root }) => ({ host: editor, root, state: 'absent' as const }));
  }
  const relTo = (abs: string): string | undefined => {
    const rel = relative(baseReal, abs);
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return undefined;
    return rel.split(sep).join('/');
  };
  return roots.map(({ editor, root }) => {
    const abs = join(base, root);
    let st: ReturnType<typeof lstatSync>;
    try {
      st = lstatSync(abs);
    } catch {
      return { host: editor, root, state: 'absent' as const };
    }
    let real: string;
    try {
      real = realpathSync(abs);
    } catch {
      return { host: editor, root, state: 'absent' as const };
    }
    if (st.isSymbolicLink()) {
      const target = relTo(real);
      return { host: editor, root, state: 'linked' as const, real, ...(target ? { target } : {}) };
    }
    if (real !== join(baseReal, root)) {
      const target = relTo(real);
      return {
        host: editor,
        root,
        state: 'linked-parent' as const,
        real,
        ...(target ? { target } : {}),
      };
    }
    return { host: editor, root, state: 'own' as const, real };
  });
}

export function skillFolderStateForWire(
  state: SkillFolderState,
): SkillFolderIdentity & { state: SkillFolderState['state']; target?: string } {
  if (state.state === 'absent') return { host: state.host, root: state.root, state: state.state };
  const { real: _real, ...wire } = state;
  return wire;
}
