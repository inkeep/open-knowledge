import {
  compareSpellings,
  type IdentityKey,
  identityKey,
  type TargetKind,
} from './target-identity.ts';

export type TargetMatch =
  | { readonly kind: 'exact'; readonly name: string }
  | { readonly kind: 'equivalent'; readonly name: string }
  | { readonly kind: 'ambiguous'; readonly name: string; readonly candidates: readonly string[] }
  | { readonly kind: 'absent' };

export interface TargetNamespace<K extends TargetKind> extends ReadonlySet<string> {
  readonly kind: K;
  lookup(spelling: string): TargetMatch;
  resolve(spelling: string): string | undefined;
}

export interface MutableTargetNamespace<K extends TargetKind> extends TargetNamespace<K> {
  add(name: string): this;
  delete(name: string): boolean;
  clear(): void;
}

const TARGET_NAMESPACE_BRAND = Symbol.for('@inkeep/open-knowledge-core/target-namespace');

class SpellingIndexedNamespace<K extends TargetKind>
  extends Set<string>
  implements MutableTargetNamespace<K>
{
  readonly kind: K;
  readonly [TARGET_NAMESPACE_BRAND] = true;
  private readonly byKey = new Map<IdentityKey<K>, string[]>();

  constructor(kind: K, names: Iterable<string>) {
    super();
    this.kind = kind;
    for (const name of names) this.add(name);
  }

  override add(name: string): this {
    if (super.has(name)) return this;
    super.add(name);
    const key = identityKey(this.kind, name);
    const bucket = this.byKey.get(key);
    if (bucket === undefined) {
      this.byKey.set(key, [name]);
      return this;
    }
    let index = 0;
    while (index < bucket.length && compareSpellings(bucket[index] as string, name) < 0) index++;
    bucket.splice(index, 0, name);
    return this;
  }

  override delete(name: string): boolean {
    if (!super.delete(name)) return false;
    const key = identityKey(this.kind, name);
    const bucket = this.byKey.get(key);
    if (bucket === undefined) return true;
    bucket.splice(bucket.indexOf(name), 1);
    if (bucket.length === 0) this.byKey.delete(key);
    return true;
  }

  override clear(): void {
    super.clear();
    this.byKey.clear();
  }

  lookup(spelling: string): TargetMatch {
    if (super.has(spelling)) return { kind: 'exact', name: spelling };
    const bucket = this.byKey.get(identityKey(this.kind, spelling));
    if (bucket === undefined) return { kind: 'absent' };
    const name = bucket[0] as string;
    return bucket.length === 1
      ? { kind: 'equivalent', name }
      : { kind: 'ambiguous', name, candidates: [...bucket] };
  }

  resolve(spelling: string): string | undefined {
    if (super.has(spelling)) return spelling;
    return this.byKey.get(identityKey(this.kind, spelling))?.[0];
  }
}

export function createTargetNamespace<K extends TargetKind>(
  kind: K,
  names: Iterable<string> = [],
): MutableTargetNamespace<K> {
  return new SpellingIndexedNamespace(kind, names);
}

export function addDocumentFolders(
  folders: MutableTargetNamespace<'folder'>,
  docNames: Iterable<string>,
): MutableTargetNamespace<'folder'> {
  for (const docName of docNames) {
    for (let slash = docName.indexOf('/'); slash !== -1; slash = docName.indexOf('/', slash + 1)) {
      folders.add(docName.slice(0, slash));
    }
  }
  return folders;
}

export function isTargetNamespace(
  names: ReadonlySet<string>,
): names is TargetNamespace<TargetKind> {
  return (
    (names as { readonly [TARGET_NAMESPACE_BRAND]?: unknown })[TARGET_NAMESPACE_BRAND] === true
  );
}

export function resolveName(names: ReadonlySet<string>, spelling: string): string | undefined {
  if (isTargetNamespace(names)) return names.resolve(spelling);
  return names.has(spelling) ? spelling : undefined;
}

function isNamespaceOfKind<K extends TargetKind>(
  names: Iterable<string>,
  kind: K,
): names is TargetNamespace<K> {
  const candidate = names as Partial<TargetNamespace<K>> & {
    readonly [TARGET_NAMESPACE_BRAND]?: unknown;
  };
  return candidate[TARGET_NAMESPACE_BRAND] === true && candidate.kind === kind;
}

export function asTargetNamespace<K extends TargetKind>(
  kind: K,
  names: Iterable<string>,
): TargetNamespace<K> {
  return isNamespaceOfKind(names, kind) ? names : createTargetNamespace(kind, names);
}
