import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gitCleanEnv } from './git-clean-env.mjs';

const ts = createRequire(import.meta.url)('typescript');

export const OK_ROOT = fileURLToPath(new URL('..', import.meta.url));
export const ALLOWLIST_PATH = fileURLToPath(
  new URL('./known-reds-allowlist.json', import.meta.url),
);
export const SCHEMA_VERSION = 1;
export const KNOWN_BUG_TAG = 'known-bug';
export const QUARANTINE_TAG = 'quarantine';
export const OWNERS = Object.freeze(['get-main-green', 'known-reds']);
export const MAX_HORIZON_DAYS = 90;
export const EXCLUDED_PREFIXES = Object.freeze(['reports/', 'specs/']);
export const CONVENTION_DOC = 'test-support/KNOWN-REDS.md';
export const MIN_SIGNATURE_LITERAL = 4;
export const EXPIRY_WARNING_DAYS = 14;

const TEST_FILE = /\.test\.[cm]?[jt]sx?$|\.e2e\.tsx?$/;
const PLAYWRIGHT_FILE = /\.e2e\.tsx?$/;
const ISSUE_URL =
  /^https:\/\/(?:github\.com\/inkeep\/[\w.-]+\/issues\/\d+|linear\.app\/inkeep\/issue\/[A-Z]+-\d+(?:\/[\w-]*)?)$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;
const RUNNER_KINDS = new Map([
  ['test', 'test'],
  ['it', 'test'],
  ['describe', 'describe'],
  ['suite', 'describe'],
]);
const HOOKS = new Set(['beforeEach', 'afterEach', 'beforeAll', 'afterAll']);
const NON_DECLARING = new Set([
  'configure',
  'use',
  'step',
  'extend',
  'info',
  'setTimeout',
  'slow',
  'expect',
]);
const NOT_RUN_MODIFIERS = new Set(['skip', 'fixme', 'todo']);
const BARE_EXPECTED_FAILURE = new Set(['fails', 'fail']);
const ANNOTATION_MODIFIERS = new Set(['skip', 'fixme', 'fail', 'slow']);
const CI_ENV_NAMES = new Set([
  'CI',
  'GITHUB_ACTIONS',
  'GITHUB_RUN_ID',
  'GITHUB_WORKFLOW',
  'RUNNER_OS',
]);
const CI_IDENTIFIERS = new Set(['CI', 'IS_CI', 'isCI', 'isCi', 'ON_CI', 'onCI', 'IN_CI', 'inCI']);
const FIELDS = ['issue', 'owner', 'until'];

function scriptKind(path) {
  if (path.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (/\.[cm]?ts$/.test(path)) return ts.ScriptKind.TS;
  if (path.endsWith('.jsx')) return ts.ScriptKind.JSX;
  return ts.ScriptKind.JS;
}

function unwrap(node) {
  let current = node;
  while (
    current &&
    (ts.isParenthesizedExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isNonNullExpression(current) ||
      ts.isSatisfiesExpression(current) ||
      ts.isTypeAssertionExpression(current))
  ) {
    current = current.expression;
  }
  return current;
}

function isFunction(node) {
  return Boolean(node) && (ts.isArrowFunction(node) || ts.isFunctionExpression(node));
}

function isTitle(node) {
  return (
    Boolean(node) &&
    (ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateExpression(node))
  );
}

function stringValue(node) {
  const value = unwrap(node);
  return value && (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value))
    ? value.text
    : null;
}

function oneLine(node, sourceFile) {
  return node.getText(sourceFile).replace(/\s+/g, ' ').trim();
}

function propertyName(property) {
  const { name } = property;
  if (name && (ts.isIdentifier(name) || ts.isStringLiteral(name))) return name.text;
  return null;
}

function objectProperty(object, name) {
  return object.properties.find(
    (property) =>
      (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) &&
      propertyName(property) === name,
  );
}

function chainOf(node) {
  const members = [];
  let current = unwrap(node);
  while (current && ts.isPropertyAccessExpression(current)) {
    members.unshift(current.name.text);
    current = unwrap(current.expression);
  }
  return { root: current, members };
}

function runnerRef(node, kinds) {
  const { root, members } = chainOf(node);
  if (!root || !ts.isIdentifier(root) || !kinds.has(root.text)) return null;
  return {
    root: root.text,
    members,
    kind: members.includes('describe') ? 'describe' : kinds.get(root.text),
  };
}

function isSkipVariant(ref) {
  return ref.members.includes('skip') || ref.members.includes('fixme');
}

function skipTernary(node, kinds) {
  const value = unwrap(node);
  if (!value || !ts.isConditionalExpression(value)) return null;
  const whenTrue = runnerRef(value.whenTrue, kinds);
  const whenFalse = runnerRef(value.whenFalse, kinds);
  if (!whenTrue || !whenFalse || isSkipVariant(whenTrue) === isSkipVariant(whenFalse)) return null;
  return {
    condition: value.condition,
    skipWhen: isSkipVariant(whenTrue) ? 'condition' : 'negation',
    ref: isSkipVariant(whenTrue) ? whenFalse : whenTrue,
  };
}

function runnerBindings(sourceFile) {
  const kinds = new Map(RUNNER_KINDS);
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const named = statement.importClause?.namedBindings;
    if (!named || !ts.isNamedImports(named)) continue;
    for (const element of named.elements) {
      const kind = RUNNER_KINDS.get((element.propertyName ?? element.name).text);
      if (kind) kinds.set(element.name.text, kind);
    }
  }
  const visit = (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const ternary = skipTernary(node.initializer, kinds);
      if (ternary) kinds.set(node.name.text, ternary.ref.kind);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return kinds;
}

function runnerCall(call, kinds) {
  const callee = unwrap(call.expression);
  const ternary = skipTernary(callee, kinds);
  if (ternary) {
    return {
      ref: ternary.ref,
      gate: { form: 'ternary', condition: ternary.condition, skipWhen: ternary.skipWhen },
    };
  }
  if (ts.isCallExpression(callee)) {
    const inner = runnerRef(callee.expression, kinds);
    if (!inner) return null;
    const last = inner.members.at(-1);
    const ref = { ...inner, members: inner.members.slice(0, -1) };
    if (last === 'skipIf' || last === 'runIf') {
      return {
        ref,
        gate: {
          form: last,
          condition: callee.arguments[0] ?? null,
          skipWhen: last === 'skipIf' ? 'condition' : 'negation',
        },
      };
    }
    return last === 'each' || last === 'for' ? { ref, gate: null, via: last } : null;
  }
  const ref = runnerRef(callee, kinds);
  return ref ? { ref, gate: null } : null;
}

function declarationKind(ref) {
  if (
    HOOKS.has(ref.root) ||
    ref.members.some((member) => HOOKS.has(member) || NON_DECLARING.has(member))
  ) {
    return 'other';
  }
  return ref.kind;
}

function declarationParts(call) {
  const args = call.arguments.map(unwrap);
  const fn = [...args].reverse().find(isFunction) ?? null;
  const options = args.slice(1).find((arg) => ts.isObjectLiteralExpression(arg)) ?? null;
  return { title: isTitle(args[0]) ? args[0] : null, fn, options };
}

function rootIdentifier(node) {
  let current = unwrap(node);
  while (current && (ts.isPropertyAccessExpression(current) || ts.isCallExpression(current))) {
    current = unwrap(current.expression);
  }
  return current && ts.isIdentifier(current) ? current.text : null;
}

function isAssertionCall(node) {
  if (!ts.isCallExpression(node)) return false;
  const root = rootIdentifier(node.expression);
  return root !== null && /^(expect|assert)/.test(root);
}

function isExpressionIdentifier(node) {
  const { parent } = node;
  if (!parent) return true;
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return false;
  if ((ts.isPropertyAssignment(parent) || ts.isBindingElement(parent)) && parent.name === node)
    return false;
  if (ts.isVariableDeclaration(parent) && parent.name === node) return false;
  if (ts.isPropertyAssignment(parent) && parent.propertyName === node) return false;
  return true;
}

function isEnvObject(node) {
  const value = unwrap(node);
  if (ts.isIdentifier(value)) return value.text === 'env';
  return ts.isPropertyAccessExpression(value) && value.name.text === 'env';
}

function ciAtom(node, aliases) {
  if (ts.isIdentifier(node)) {
    if (!isExpressionIdentifier(node)) return null;
    if (aliases.has(node.text)) return aliases.get(node.text);
    return CI_IDENTIFIERS.has(node.text) ? 'positive' : null;
  }
  if (
    ts.isPropertyAccessExpression(node) &&
    CI_ENV_NAMES.has(node.name.text) &&
    isEnvObject(node.expression)
  ) {
    return 'positive';
  }
  if (ts.isElementAccessExpression(node) && isEnvObject(node.expression)) {
    const key = stringValue(node.argumentExpression);
    return key !== null && CI_ENV_NAMES.has(key) ? 'positive' : null;
  }
  return null;
}

function containsCi(node, aliases) {
  let found = false;
  const visit = (current) => {
    if (found) return;
    if (ciAtom(current, aliases)) {
      found = true;
      return;
    }
    if (isFunction(current) || ts.isFunctionDeclaration(current)) return;
    ts.forEachChild(current, visit);
  };
  visit(node);
  return found;
}

function literalTruth(node) {
  const value = unwrap(node);
  if (value.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (value.kind === ts.SyntaxKind.FalseKeyword || value.kind === ts.SyntaxKind.NullKeyword)
    return false;
  if (ts.isIdentifier(value) && value.text === 'undefined') return false;
  if (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)) {
    return !['', '0', 'false'].includes(value.text);
  }
  if (ts.isNumericLiteral(value)) return Number(value.text) !== 0;
  return null;
}

const EQUALITY = new Set([ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken]);
const INEQUALITY = new Set([
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
]);

function not(value) {
  return value === null ? null : !value;
}

function ciValue(node, aliases, onCi) {
  const value = unwrap(node);
  if (!value || !containsCi(value, aliases)) return null;
  const atom = ciAtom(value, aliases);
  if (atom === 'positive') return onCi;
  if (atom === 'negative') return !onCi;
  if (atom === 'unknown') return null;
  if (ts.isPrefixUnaryExpression(value) && value.operator === ts.SyntaxKind.ExclamationToken) {
    return not(ciValue(value.operand, aliases, onCi));
  }
  if (ts.isBinaryExpression(value)) {
    const operator = value.operatorToken.kind;
    if (operator === ts.SyntaxKind.AmpersandAmpersandToken) {
      const left = ciValue(value.left, aliases, onCi);
      const right = ciValue(value.right, aliases, onCi);
      if (left === false || right === false) return false;
      return left === true && right === true ? true : null;
    }
    if (operator === ts.SyntaxKind.BarBarToken) {
      const left = ciValue(value.left, aliases, onCi);
      const right = ciValue(value.right, aliases, onCi);
      if (left === true || right === true) return true;
      return left === false && right === false ? false : null;
    }
    if (EQUALITY.has(operator) || INEQUALITY.has(operator)) {
      const ciOnLeft = containsCi(value.left, aliases);
      if (ciOnLeft === containsCi(value.right, aliases)) return null;
      const side = ciValue(ciOnLeft ? value.left : value.right, aliases, onCi);
      const truth = literalTruth(ciOnLeft ? value.right : value.left);
      if (side === null || truth === null) return null;
      return EQUALITY.has(operator) ? side === truth : side !== truth;
    }
  }
  if (
    ts.isCallExpression(value) &&
    ts.isIdentifier(value.expression) &&
    value.expression.text === 'Boolean' &&
    value.arguments.length === 1
  ) {
    return ciValue(value.arguments[0], aliases, onCi);
  }
  return null;
}

function declarationsAtAnyDepth(sourceFile, kinds) {
  const declarations = [];
  const collect = (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      !skipTernary(node.initializer, kinds)
    ) {
      declarations.push(node);
    }
    ts.forEachChild(node, collect);
  };
  collect(sourceFile);
  return declarations;
}

function ciAliases(sourceFile, kinds) {
  const declarations = declarationsAtAnyDepth(sourceFile, kinds);
  const aliases = new Map();
  for (let pass = 0; pass < 3; pass += 1) {
    for (const declaration of declarations) {
      if (!containsCi(declaration.initializer, aliases)) continue;
      const onCi = ciValue(declaration.initializer, aliases, true);
      const offCi = ciValue(declaration.initializer, aliases, false);
      const polarity =
        onCi === true && offCi === false
          ? 'positive'
          : onCi === false && offCi === true
            ? 'negative'
            : 'unknown';
      aliases.set(declaration.name.text, polarity);
    }
  }
  return aliases;
}

const PROCESS_ENVIRONMENT = new Set([
  'platform',
  'arch',
  'env',
  'getuid',
  'getgid',
  'versions',
  'release',
]);
const OS_MODULES = new Set(['os', 'node:os']);
const FS_PRESENCE = new Set(['existsSync']);

function environmentImports(sourceFile) {
  const names = new Set();
  const namespaces = new Set();
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier))
      continue;
    if (!OS_MODULES.has(statement.moduleSpecifier.text)) continue;
    const clause = statement.importClause;
    if (clause?.name) namespaces.add(clause.name.text);
    const named = clause?.namedBindings;
    if (named && ts.isNamespaceImport(named)) namespaces.add(named.name.text);
    if (named && ts.isNamedImports(named))
      for (const element of named.elements) names.add(element.name.text);
  }
  return { names, namespaces };
}

function isEnvironmentAtom(node, environment) {
  if (ciAtom(node, environment.ciAliases)) return true;
  if (ts.isPropertyAccessExpression(node)) {
    const target = unwrap(node.expression);
    if (
      ts.isIdentifier(target) &&
      target.text === 'process' &&
      PROCESS_ENVIRONMENT.has(node.name.text)
    )
      return true;
    if (ts.isIdentifier(target) && environment.imports.namespaces.has(target.text)) return true;
  }
  if (ts.isIdentifier(node) && isExpressionIdentifier(node)) {
    return environment.imports.names.has(node.text) || environment.aliases.has(node.text);
  }
  if (ts.isCallExpression(node)) {
    const callee = unwrap(node.expression);
    const name = ts.isIdentifier(callee)
      ? callee.text
      : ts.isPropertyAccessExpression(callee)
        ? callee.name.text
        : null;
    return name !== null && FS_PRESENCE.has(name);
  }
  return false;
}

function dependsOnEnvironment(node, environment) {
  let found = false;
  const visit = (current) => {
    if (found) return;
    if (isEnvironmentAtom(current, environment)) {
      found = true;
      return;
    }
    if (isFunction(current) || ts.isFunctionDeclaration(current)) return;
    ts.forEachChild(current, visit);
  };
  visit(node);
  return found;
}

function environmentBindings(sourceFile, ciAliasMap, kinds) {
  const environment = {
    ciAliases: ciAliasMap,
    imports: environmentImports(sourceFile),
    aliases: new Set(),
  };
  const declarations = declarationsAtAnyDepth(sourceFile, kinds);
  for (let pass = 0; pass < 3; pass += 1) {
    for (const declaration of declarations) {
      if (dependsOnEnvironment(declaration.initializer, environment))
        environment.aliases.add(declaration.name.text);
    }
  }
  return environment;
}

function ciEffect(condition, skipWhen, aliases) {
  if (!containsCi(condition, aliases)) return null;
  const skipWhenTrue = ciValue(condition, aliases, true);
  const skipsOnCi = skipWhen === 'condition' ? skipWhenTrue : not(skipWhenTrue);
  return skipsOnCi === false ? 'runs-only-on-ci' : 'skips-on-ci';
}

function enclosingCondition(node, boundary) {
  let child = node;
  let current = node.parent;
  while (
    current &&
    current !== boundary &&
    !isFunction(current) &&
    !ts.isFunctionDeclaration(current)
  ) {
    if (ts.isIfStatement(current) && child !== current.expression) {
      return {
        condition: current.expression,
        skipWhen: child === current.thenStatement ? 'condition' : 'negation',
      };
    }
    child = current;
    current = current.parent;
  }
  return null;
}

function containsBefore(scope, position, predicate) {
  let found = false;
  const visit = (node) => {
    if (found || node.getStart() >= position) return;
    if (predicate(node)) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(scope);
  return found;
}

function readTags(options, key) {
  const property = options && objectProperty(options, key);
  if (!property) return { tags: [], literal: true };
  if (!ts.isPropertyAssignment(property)) return { tags: [], literal: false };
  const value = unwrap(property.initializer);
  const single = stringValue(value);
  if (single !== null) return { tags: [single], literal: true };
  if (!ts.isArrayLiteralExpression(value)) return { tags: [], literal: false };
  const tags = value.elements.map(stringValue);
  return tags.includes(null)
    ? { tags: tags.filter((tag) => tag !== null), literal: false }
    : { tags, literal: true };
}

function readVitestFields(options) {
  const property = options && objectProperty(options, 'meta');
  if (!property) return { fields: {}, literal: true };
  const value = ts.isPropertyAssignment(property) ? unwrap(property.initializer) : null;
  if (!value || !ts.isObjectLiteralExpression(value)) return { fields: {}, literal: false };
  const fields = {};
  let literal = true;
  for (const name of FIELDS) {
    const field = objectProperty(value, name);
    if (!field) continue;
    const text = ts.isPropertyAssignment(field) ? stringValue(field.initializer) : null;
    if (text === null) literal = false;
    else fields[name] = text;
  }
  return { fields, literal };
}

function readPlaywrightFields(options) {
  const property = options && objectProperty(options, 'annotation');
  if (!property) return { fields: {}, literal: true };
  const value = ts.isPropertyAssignment(property) ? unwrap(property.initializer) : null;
  const entries =
    value && ts.isArrayLiteralExpression(value) ? value.elements.map(unwrap) : [value];
  const fields = {};
  let literal = true;
  for (const entry of entries) {
    if (!entry || !ts.isObjectLiteralExpression(entry)) {
      literal = false;
      continue;
    }
    const typeProperty = objectProperty(entry, 'type');
    const descriptionProperty = objectProperty(entry, 'description');
    const type =
      typeProperty && ts.isPropertyAssignment(typeProperty)
        ? stringValue(typeProperty.initializer)
        : null;
    if (type === null) {
      literal = false;
      continue;
    }
    if (!FIELDS.includes(type)) continue;
    const description =
      descriptionProperty && ts.isPropertyAssignment(descriptionProperty)
        ? stringValue(descriptionProperty.initializer)
        : null;
    if (description === null) literal = false;
    else fields[type] = description;
  }
  return { fields, literal };
}

function configuredRetries(statements, kinds) {
  for (const statement of statements) {
    if (!ts.isExpressionStatement(statement)) continue;
    const call = unwrap(statement.expression);
    if (!ts.isCallExpression(call)) continue;
    const ref = runnerRef(call.expression, kinds);
    if (ref?.members.at(-1) !== 'configure') continue;
    const options = call.arguments[0] ? unwrap(call.arguments[0]) : null;
    if (!options || !ts.isObjectLiteralExpression(options)) continue;
    const retries = objectProperty(options, 'retries');
    if (!retries) continue;
    const value = ts.isPropertyAssignment(retries) ? unwrap(retries.initializer) : null;
    return value && ts.isNumericLiteral(value) ? Number(value.text) : Number.NaN;
  }
  return undefined;
}

function effectiveRetries(call, kinds) {
  let current = call.parent;
  while (current) {
    if (
      isFunction(current) &&
      current.parent &&
      ts.isCallExpression(current.parent) &&
      ts.isBlock(current.body)
    ) {
      const owner = runnerCall(current.parent, kinds);
      if (owner && declarationKind(owner.ref) === 'describe') {
        const retries = configuredRetries(current.body.statements, kinds);
        if (retries !== undefined) return retries;
      }
    }
    if (ts.isSourceFile(current)) return configuredRetries(current.statements, kinds);
    current = current.parent;
  }
  return undefined;
}

function longestLiteralRun(regexLiteral) {
  const pattern = regexLiteral.slice(1, regexLiteral.lastIndexOf('/'));
  const cut = String.fromCharCode(0);
  const literal = pattern
    .replace(/\[(?:\\.|[^\]\\])*\]/g, cut)
    .replace(/\\[pPu]\{[^}]*\}|\\x[0-9a-fA-F]{2}|\\u[0-9a-fA-F]{4}|\\c[A-Za-z]/g, cut)
    .replace(/\\[dDwWsSbB]/g, cut)
    .replace(/\\./g, 'x')
    .replace(/\{\d*,?\d*\}/g, cut)
    .replace(/[.^$*+?()|{}]/g, cut);
  return Math.max(0, ...literal.split(cut).map((part) => part.length));
}

function findSignature(fn) {
  let found = null;
  const visit = (node) => {
    if (found) return;
    if (ts.isCallExpression(node)) {
      const callee = unwrap(node.expression);
      const name = ts.isIdentifier(callee)
        ? callee.text
        : ts.isPropertyAccessExpression(callee)
          ? callee.name.text
          : null;
      if (name === 'expectKnownBug') {
        const signature = node.arguments[0] ? unwrap(node.arguments[0]) : null;
        found = {
          node,
          signature: signature && ts.isRegularExpressionLiteral(signature) ? signature.text : null,
        };
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(fn);
  return found;
}

function scopeOf(node, kinds) {
  let current = node.parent;
  while (current) {
    if (
      isFunction(current) ||
      ts.isFunctionDeclaration(current) ||
      ts.isMethodDeclaration(current)
    ) {
      const owner =
        current.parent && ts.isCallExpression(current.parent)
          ? runnerCall(current.parent, kinds)
          : null;
      const kind = owner ? declarationKind(owner.ref) : null;
      return kind === 'test' || kind === 'describe' ? kind : 'helper';
    }
    current = current.parent;
  }
  return 'file';
}

export function scanSource(path, source) {
  const sourceFile = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    true,
    scriptKind(path),
  );
  const runner = PLAYWRIGHT_FILE.test(path) ? 'playwright' : 'vitest';
  const kinds = runnerBindings(sourceFile);
  const aliases = ciAliases(sourceFile, kinds);
  const environment = environmentBindings(sourceFile, aliases, kinds);
  const scan = {
    path,
    runner,
    pins: [],
    quarantines: [],
    gates: [],
    notRun: [],
    earlyReturns: [],
    problems: [],
  };
  const lineOf = (node) =>
    sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
  const problem = (node, rule, message) =>
    scan.problems.push({ path, line: lineOf(node), rule, message });
  const gate = (node, form, scope, condition, skipWhen, reason = '') => {
    scan.gates.push({
      path,
      line: lineOf(node),
      form,
      scope,
      condition: condition ? oneLine(condition, sourceFile) : '',
      skipWhen,
      ci: condition ? ciEffect(condition, skipWhen, aliases) : null,
      reason,
    });
  };
  const notRun = (node, form, scope, title, reason = '') =>
    scan.notRun.push({ path, line: lineOf(node), form, scope, title, reason });

  const inspectTestBody = (fn, via) => {
    const context = via === 'each' ? undefined : fn.parameters[via === 'for' ? 1 : 0]?.name;
    const contextNames = new Set();
    const skipNames = new Set();
    if (context && ts.isIdentifier(context)) contextNames.add(context.text);
    if (context && ts.isObjectBindingPattern(context)) {
      for (const element of context.elements) {
        const key = (element.propertyName ?? element.name).getText(sourceFile);
        if (key === 'skip' && ts.isIdentifier(element.name)) skipNames.add(element.name.text);
      }
    }
    const isContextSkip = (node) => {
      if (!ts.isCallExpression(node)) return false;
      const callee = unwrap(node.expression);
      if (ts.isIdentifier(callee)) return skipNames.has(callee.text);
      return (
        ts.isPropertyAccessExpression(callee) &&
        callee.name.text === 'skip' &&
        ts.isIdentifier(unwrap(callee.expression)) &&
        contextNames.has(unwrap(callee.expression).text)
      );
    };
    const isAnySkip = (node) => {
      if (isContextSkip(node)) return true;
      if (!ts.isCallExpression(node)) return false;
      const ref = runnerRef(node.expression, kinds);
      return Boolean(ref) && ref.members.at(-1) === 'skip';
    };
    const visit = (node) => {
      if (node !== fn && (isFunction(node) || ts.isFunctionDeclaration(node))) return;
      if (isContextSkip(node)) {
        const [first, second] = node.arguments;
        if (first && !isTitle(unwrap(first))) {
          gate(
            node,
            'context-skip',
            'test',
            first,
            'condition',
            second ? (stringValue(second) ?? '') : '',
          );
        } else {
          const around = enclosingCondition(node, fn);
          const reason = first ? (stringValue(first) ?? '') : '';
          if (around) gate(node, 'context-skip', 'test', around.condition, around.skipWhen, reason);
          else notRun(node, 'context-skip', 'test', '', reason);
        }
      }
      if (ts.isReturnStatement(node) && !node.expression) {
        const around = enclosingCondition(node, fn);
        if (around && dependsOnEnvironment(around.condition, environment)) {
          const guarded = containsBefore(
            fn.body,
            node.getStart(),
            (candidate) => isAssertionCall(candidate) || isAnySkip(candidate),
          );
          if (!guarded) {
            scan.earlyReturns.push({
              path,
              line: lineOf(node),
              condition: oneLine(around.condition, sourceFile),
            });
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(fn, visit);
  };

  const inspectDeclaration = (call, info, kind) => {
    const parts = declarationParts(call);
    const modifiers = new Set(info.ref.members);
    const title = parts.title ? (stringValue(parts.title) ?? oneLine(parts.title, sourceFile)) : '';
    const tagKey = runner === 'playwright' ? 'tag' : 'tags';
    const { tags, literal } = readTags(parts.options, tagKey);
    if (!literal) {
      problem(
        call,
        'tags-not-literal',
        `write \`${tagKey}\` as inline string literals so the known-reds listing can see it`,
      );
    }
    const pinTag = runner === 'playwright' ? `@${KNOWN_BUG_TAG}` : KNOWN_BUG_TAG;
    const quarantineTag = runner === 'playwright' ? `@${QUARANTINE_TAG}` : QUARANTINE_TAG;
    const isPin = tags.includes(pinTag);
    const isQuarantine = tags.includes(quarantineTag);
    const skipOption = parts.options && objectProperty(parts.options, 'skip');
    const skipValue =
      skipOption && ts.isPropertyAssignment(skipOption)
        ? unwrap(skipOption.initializer)
        : skipOption
          ? skipOption.name
          : null;
    const skipTruth = skipValue ? literalTruth(skipValue) : false;
    const todoOption = parts.options && objectProperty(parts.options, 'todo');
    const failsOption = parts.options && objectProperty(parts.options, 'fails');
    if (failsOption) {
      problem(
        call,
        'bare-expected-failure',
        'an expected-failure marker accepts any failure; pin the bug with expectKnownBug instead',
      );
    }
    const declaredNotRun =
      [...modifiers].find((modifier) => NOT_RUN_MODIFIERS.has(modifier)) ?? null;
    const skipped = Boolean(declaredNotRun) || skipTruth === true || Boolean(todoOption);
    if (skipValue && skipTruth === null) gate(call, 'skip-option', kind, skipValue, 'condition');
    if ((isPin || isQuarantine) && kind === 'describe') {
      problem(
        call,
        'tag-on-describe',
        `tag each test ${isPin ? pinTag : quarantineTag}, not the describe, so every pin carries its own issue, owner and date`,
      );
    } else if (isPin || isQuarantine) {
      const { fields, literal: fieldsLiteral } =
        runner === 'playwright'
          ? readPlaywrightFields(parts.options)
          : readVitestFields(parts.options);
      if (!fieldsLiteral) {
        problem(
          call,
          'fields-not-literal',
          `write the issue, owner and until ${runner === 'playwright' ? 'annotations' : 'meta'} as inline string literals`,
        );
      }
      const record = { path, line: lineOf(call), runner, title, ...fields };
      if (isPin && isQuarantine)
        problem(
          call,
          'pin-and-quarantine',
          'a test is either a pinned known bug or a quarantined flake, not both',
        );
      if (isPin) {
        const found = parts.fn ? findSignature(parts.fn) : null;
        record.signature = found?.signature ?? null;
        if (!found) {
          problem(
            call,
            'pin-without-helper',
            'a known-bug pin must wrap its correct assertion in expectKnownBug(/signature/, fn)',
          );
        } else if (found.signature === null) {
          problem(
            found.node,
            'signature-not-literal',
            'pass expectKnownBug a regular-expression literal naming the observed wrong outcome',
          );
        } else if (longestLiteralRun(found.signature) < MIN_SIGNATURE_LITERAL) {
          problem(
            found.node,
            'signature-too-broad',
            `a pin's signature must name the observed wrong outcome with at least ${MIN_SIGNATURE_LITERAL} literal characters in a row; a pattern like /./ absorbs any failure`,
          );
        }
        if (skipped)
          problem(
            call,
            'pin-not-run',
            'a known-bug pin must run; a pin that is skipped checks nothing',
          );
        if (runner === 'playwright') {
          const retries = effectiveRetries(call, kinds);
          if (retries !== 0) {
            problem(
              call,
              'pin-retries',
              'run a Playwright pin with `test.describe.configure({ retries: 0 })` in its describe, so a retry cannot turn a changed failure into a flaky pass',
            );
          }
        }
        scan.pins.push(record);
      } else {
        if (!skipped)
          problem(call, 'quarantine-runs', 'a quarantined flake is declared skipped, with `.skip`');
        scan.quarantines.push(record);
      }
    } else if (skipped) {
      const form = declaredNotRun ?? (todoOption ? 'todo-option' : 'skip-option');
      notRun(call, form, kind, title);
    }
    if (info.gate) {
      gate(call, info.gate.form, kind, info.gate.condition, info.gate.skipWhen);
    }
    if (kind === 'test' && parts.fn) inspectTestBody(parts.fn, info.via);
  };

  const inspectAnnotation = (call, modifier) => {
    const [first, second] = call.arguments.map(unwrap);
    const scope = scopeOf(call, kinds);
    const reason = second ? (stringValue(second) ?? '') : '';
    if (modifier === 'fail') {
      problem(
        call,
        'bare-expected-failure',
        'test.fail() accepts any failure in the test body; pin the bug with expectKnownBug instead',
      );
      return;
    }
    if (modifier === 'slow') return;
    if (first && isFunction(first)) {
      const body = ts.isBlock(first.body) ? null : first.body;
      gate(call, `${modifier}-callback`, scope, body ?? first, 'condition', reason);
      return;
    }
    const truth = first ? literalTruth(first) : true;
    if (truth === false) return;
    if (truth === null) {
      gate(call, modifier, scope, first, 'condition', reason);
      return;
    }
    const around = enclosingCondition(call, null);
    if (around) gate(call, modifier, scope, around.condition, around.skipWhen, reason);
    else notRun(call, modifier, scope, '', reason);
  };

  const visit = (node) => {
    if (ts.isVariableDeclaration(node) && node.initializer) {
      const ternary = skipTernary(node.initializer, kinds);
      if (ternary) {
        const topLevel =
          ts.isVariableStatement(node.parent?.parent) && ts.isSourceFile(node.parent.parent.parent);
        gate(
          node,
          'alias',
          topLevel ? 'file' : scopeOf(node, kinds),
          ternary.condition,
          ternary.skipWhen,
        );
      }
    }
    if (ts.isCallExpression(node)) {
      const info = runnerCall(node, kinds);
      if (info) {
        const kind = declarationKind(info.ref);
        const bare = info.ref.members.find((member) => BARE_EXPECTED_FAILURE.has(member));
        const parts = kind === 'test' || kind === 'describe' ? declarationParts(node) : null;
        const annotation =
          kind === 'test' &&
          parts &&
          !parts.title &&
          ANNOTATION_MODIFIERS.has(info.ref.members.at(-1) ?? '') &&
          !info.gate;
        if (annotation) {
          inspectAnnotation(node, info.ref.members.at(-1));
        } else if (parts && (parts.fn || info.ref.members.includes('todo'))) {
          if (bare) {
            problem(
              node,
              'bare-expected-failure',
              `\`.${bare}\` accepts any failure; pin the bug with expectKnownBug instead`,
            );
          }
          inspectDeclaration(node, info, kind);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return scan;
}

export function listTestFiles(root) {
  const listed = spawnSync(
    'git',
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    {
      cwd: root,
      encoding: 'utf8',
      env: gitCleanEnv(),
      maxBuffer: 1 << 28,
      windowsHide: true,
    },
  );
  if (listed.error || listed.status !== 0) {
    throw new Error(
      `known-reds: git ls-files failed in ${root} (${listed.error?.message ?? listed.stderr.trim()}), so the scan cannot show that it read every test file.`,
    );
  }
  return listed.stdout
    .split('\0')
    .filter(
      (path) =>
        path !== '' &&
        TEST_FILE.test(path) &&
        !path.includes('node_modules/') &&
        !EXCLUDED_PREFIXES.some((prefix) => path.startsWith(prefix)) &&
        existsSync(join(root, path)),
    )
    .sort();
}

export function scanTree(root) {
  if (typeof ts.createSourceFile !== 'function') {
    throw new Error(
      `known-reds: the resolved typescript ${ts.version} has no createSourceFile, so the scan cannot run.`,
    );
  }
  const files = listTestFiles(root);
  const report = {
    schemaVersion: SCHEMA_VERSION,
    files: files.length,
    pins: [],
    quarantines: [],
    ciSkips: [],
    envGates: [],
    notRun: [],
    earlyReturns: [],
    problems: [],
  };
  for (const path of files) {
    const scan = scanSource(path, readFileSync(join(root, path), 'utf8'));
    report.pins.push(...scan.pins);
    report.quarantines.push(...scan.quarantines);
    report.notRun.push(...scan.notRun);
    report.earlyReturns.push(...scan.earlyReturns);
    report.problems.push(...scan.problems);
    for (const entry of scan.gates)
      (entry.ci === 'skips-on-ci' ? report.ciSkips : report.envGates).push(entry);
  }
  return report;
}

export function todayUtc(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

function addDays(day, days) {
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

function dateProblem(until, today) {
  if (!until) return 'has no until date';
  if (!ISO_DATE.test(until)) return `has until "${until}", which is not YYYY-MM-DD`;
  const time = Date.parse(`${until}T00:00:00Z`);
  if (Number.isNaN(time) || new Date(time).toISOString().slice(0, 10) !== until)
    return `has until "${until}", which is not a date`;
  if (until < today) return `expired on ${until}`;
  const horizon = addDays(today, MAX_HORIZON_DAYS);
  if (until > horizon)
    return `has until ${until}, beyond the ${MAX_HORIZON_DAYS}-day horizon (${horizon})`;
  return null;
}

function trackedProblems(entry, today, { needsIssue }) {
  const problems = [];
  if (needsIssue && !entry.issue) problems.push('has no issue link');
  if (entry.issue && !ISSUE_URL.test(entry.issue))
    problems.push(`has issue "${entry.issue}", which is not a GitHub or Linear issue URL`);
  if (!entry.owner) problems.push('has no owner');
  else if (!OWNERS.includes(entry.owner))
    problems.push(`has owner "${entry.owner}", which is not one of ${OWNERS.join(', ')}`);
  const date = dateProblem(entry.until, today);
  if (date) problems.push(date);
  return problems;
}

export function loadAllowlist(path = ALLOWLIST_PATH) {
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  if (!parsed || !Array.isArray(parsed.ciSkips)) {
    throw new Error(`known-reds: ${path} must hold { "ciSkips": [...] }.`);
  }
  return parsed;
}

export function validate(report, { today, allowlist }) {
  const violations = [...report.problems];
  for (const pin of report.pins) {
    for (const message of trackedProblems(pin, today, { needsIssue: true })) {
      violations.push({
        path: pin.path,
        line: pin.line,
        rule: 'pin-fields',
        message: `known-bug pin ${message}`,
      });
    }
  }
  for (const quarantine of report.quarantines) {
    for (const message of trackedProblems(quarantine, today, { needsIssue: true })) {
      violations.push({
        path: quarantine.path,
        line: quarantine.line,
        rule: 'quarantine-fields',
        message: `quarantine ${message}`,
      });
    }
  }
  for (const early of report.earlyReturns) {
    violations.push({
      path: early.path,
      line: early.line,
      rule: 'early-return',
      message: `returns early when ${early.condition}, so the test reports a pass without running; skip it instead (ctx.skip(condition, note) in Vitest, test.skip(condition, reason) in Playwright)`,
    });
  }
  const entries = allowlist.ciSkips;
  const matched = new Set();
  for (const skip of report.ciSkips) {
    const index = entries.findIndex(
      (entry, at) =>
        !matched.has(at) && entry.path === skip.path && entry.condition === skip.condition,
    );
    if (index === -1) {
      violations.push({
        path: skip.path,
        line: skip.line,
        rule: 'ci-skip',
        message: `skips on CI (${skip.condition}), so CI reports it green without running it; run it on CI, or key the skip on the missing capability rather than on CI`,
      });
    } else {
      matched.add(index);
    }
  }
  entries.forEach((entry, index) => {
    const where = { path: `scripts/known-reds-allowlist.json`, line: index + 1 };
    if (!matched.has(index)) {
      violations.push({
        ...where,
        rule: 'allowlist-stale',
        message: `entry ${entry.path} (${entry.condition}) matches no CI-keyed skip; remove it`,
      });
    }
    if (!entry.reason)
      violations.push({
        ...where,
        rule: 'allowlist-fields',
        message: `entry ${entry.path} has no reason`,
      });
    for (const message of trackedProblems(entry, today, { needsIssue: false })) {
      violations.push({
        ...where,
        rule: 'allowlist-fields',
        message: `entry ${entry.path} ${message}`,
      });
    }
  });
  return violations;
}

export function expiringSoon(report, { today, allowlist }) {
  const limit = addDays(today, EXPIRY_WARNING_DAYS);
  const due = (entry) =>
    typeof entry.until === 'string' &&
    ISO_DATE.test(entry.until) &&
    entry.until >= today &&
    entry.until <= limit;
  const row = (kind) => (entry) => ({
    kind,
    path: entry.path,
    line: entry.line ?? null,
    owner: entry.owner ?? null,
    until: entry.until,
  });
  return [
    ...report.pins.filter(due).map(row('pin')),
    ...report.quarantines.filter(due).map(row('quarantine')),
    ...allowlist.ciSkips.filter(due).map(row('ci-skip-entry')),
  ];
}

const EXPIRING_KIND_LABELS = {
  pin: 'pin',
  quarantine: 'quarantine',
  'ci-skip-entry': 'allowlisted CI skip',
};

export function render(report, violations, upcoming, today, { all }) {
  const lines = [
    `Known reds in open-knowledge on ${today}: ${report.files} test files scanned.`,
    '',
  ];
  const section = (heading, rows, format, show = true) => {
    lines.push(`${heading} (${rows.length})`);
    if (show) for (const row of rows) lines.push(`  ${format(row)}`);
    lines.push('');
  };
  section(
    'Pinned known bugs',
    report.pins,
    (pin) =>
      `${pin.path}:${pin.line}  ${pin.title}  ${pin.issue ?? '?'}  owner ${pin.owner ?? '?'}, until ${pin.until ?? '?'}  ${pin.signature ?? ''}`,
  );
  section(
    'Quarantined flakes',
    report.quarantines,
    (row) =>
      `${row.path}:${row.line}  ${row.title}  ${row.issue ?? '?'}  owner ${row.owner ?? '?'}, until ${row.until ?? '?'}`,
  );
  section(
    'Skipped on CI',
    report.ciSkips,
    (row) => `${row.path}:${row.line}  ${row.scope}  ${row.condition}`,
  );
  section(
    'Not run: skip, fixme and todo',
    report.notRun,
    (row) => `${row.path}:${row.line}  ${row.form}  ${row.title || row.reason}`,
    all,
  );
  section(
    'Environment gates',
    report.envGates,
    (row) =>
      `${row.path}:${row.line}  ${row.form}  ${row.condition}${row.ci ? '  (runs only on CI)' : ''}`,
    all,
  );
  section(
    `Expiring within ${EXPIRY_WARNING_DAYS} days`,
    upcoming,
    (row) =>
      `${EXPIRING_KIND_LABELS[row.kind] ?? row.kind}  ${row.path}${row.line === null ? '' : `:${row.line}`}  owner ${row.owner ?? '?'}, until ${row.until}`,
  );
  section(
    'Violations',
    violations,
    (row) => `${row.path}:${row.line}  [${row.rule}]  ${row.message}`,
  );
  if (!all)
    lines.push(
      'Pass --all to list every not-run test and environment gate, or --json for the full feed.',
    );
  lines.push(`The convention: ${CONVENTION_DOC}.`);
  return `${lines.join('\n')}\n`;
}

function main(argv) {
  try {
    const rootAt = argv.indexOf('--root');
    const root = rootAt === -1 ? OK_ROOT : resolve(argv[rootAt + 1] ?? '');
    const today = todayUtc();
    const report = scanTree(root);
    const allowlist = loadAllowlist();
    const violations = validate(report, { today, allowlist });
    const upcoming = expiringSoon(report, { today, allowlist });
    if (argv.includes('--json')) {
      process.stdout.write(
        `${JSON.stringify({ ...report, today, expiringSoon: upcoming, violations }, null, 2)}\n`,
      );
    } else {
      process.stdout.write(
        render(report, violations, upcoming, today, { all: argv.includes('--all') }),
      );
    }
    process.exitCode = violations.length > 0 ? 1 : 0;
  } catch (error) {
    process.stderr.write(
      `known-reds: could not run: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 2;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main(process.argv.slice(2));
