import { docsUrl } from '../docs.mjs';
import { sonnerToastBindings, toastCallMethod } from '../toast.mjs';

const URL = docsUrl('no-raw-error-toast');

const MESSAGE = `Raw error text in a toast. An error's \`message\` or string form is untranslatable, often an internal message, and frequently wrong for the user. Map the failure to a reason and write translated copy for it ("Couldn't {verb} {thing}."); put the raw detail behind a Show details disclosure or in Report a bug instead. See ${URL}`;

const TYPED = new Set(['', 'error', 'warning', 'info', 'success', 'loading', 'message']);
const ERROR_NAMES = new Set(['err', 'error', 'e', 'ex', 'cause', 'reason']);
const ERROR_SUFFIX = /[a-z0-9_](?:Error|Err)$/;
const WRAPPERS = new Set([
  'ChainExpression',
  'ParenthesizedExpression',
  'TSAsExpression',
  'TSNonNullExpression',
  'TSSatisfiesExpression',
  'TSTypeAssertion',
]);

function unwrap(node) {
  let current = node;
  while (current && WRAPPERS.has(current.type)) current = current.expression;
  return current;
}

function isErrorName(name) {
  return ERROR_NAMES.has(name) || ERROR_SUFFIX.test(name);
}

function isErrorValue(node) {
  const value = unwrap(node);
  if (value?.type === 'Identifier') return isErrorName(value.name);
  return (
    value?.type === 'MemberExpression' &&
    !value.computed &&
    value.property?.type === 'Identifier' &&
    isErrorName(value.property.name)
  );
}

function memberName(node) {
  if (node?.type !== 'MemberExpression' || node.computed) return '';
  return node.property?.type === 'Identifier' ? node.property.name : '';
}

function interpolatesRawError(template) {
  return template.expressions.some(isRawErrorText);
}

function isRawErrorText(node) {
  const value = unwrap(node);
  if (!value) return false;
  if (isErrorValue(value)) return true;
  switch (value.type) {
    case 'ConditionalExpression':
      return isRawErrorText(value.consequent) || isRawErrorText(value.alternate);
    case 'LogicalExpression':
      if (value.operator === '&&') return isRawErrorText(value.right);
      return isRawErrorText(value.left) || isRawErrorText(value.right);
    case 'BinaryExpression':
      if (value.operator !== '+') return false;
      return isRawErrorText(value.left) || isRawErrorText(value.right);
    case 'TemplateLiteral':
      return interpolatesRawError(value);
    case 'TaggedTemplateExpression':
      return value.tag?.type === 'Identifier' && value.tag.name === 't'
        ? interpolatesRawError(value.quasi)
        : false;
    case 'MemberExpression':
      return memberName(value) === 'message' && isErrorValue(value.object);
    case 'CallExpression': {
      const callee = value.callee;
      if (callee?.type === 'Identifier' && callee.name === 'errorText') return true;
      if (callee?.type === 'Identifier' && callee.name === 'String') {
        return value.arguments.length === 1 && isErrorValue(value.arguments[0]);
      }
      return (
        memberName(callee) === 'toString' &&
        value.arguments.length === 0 &&
        isErrorValue(callee.object)
      );
    }
    default:
      return false;
  }
}

function descriptionOf(options) {
  const value = unwrap(options);
  if (value?.type !== 'ObjectExpression') return null;
  for (const property of value.properties) {
    if (property.type !== 'Property' || property.computed) continue;
    const key = property.key;
    const name = key?.type === 'Identifier' ? key.name : key?.value;
    if (name === 'description') return property.value;
  }
  return null;
}

export const noRawErrorToast = {
  meta: {
    type: 'problem',
    docs: {
      description: "A toast's message and description must not be raw error text.",
      url: URL,
    },
  },
  create(context) {
    let bindings = { direct: new Set(), namespaces: new Set() };
    return {
      Program(node) {
        bindings = sonnerToastBindings(node);
      },
      CallExpression(node) {
        if (!TYPED.has(toastCallMethod(node, bindings, context.sourceCode))) return;
        const [message, options] = node.arguments;
        if (isRawErrorText(message)) context.report({ node: message, message: MESSAGE });
        const description = descriptionOf(options);
        if (isRawErrorText(description)) context.report({ node: description, message: MESSAGE });
      },
    };
  },
};
