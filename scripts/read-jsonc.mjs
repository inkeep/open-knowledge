import fs from 'node:fs';

export function stripJsonc(text) {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    const d = text[i + 1];
    if (c === '/' && d === '/') {
      while (i < text.length && text[i] !== '\n') i += 1;
      continue;
    }
    if (c === '/' && d === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i += 1;
      i = Math.min(i + 2, text.length);
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      while (j < text.length) {
        if (text[j] === '\\') {
          j += 2;
          continue;
        }
        if (text[j] === '"') {
          j += 1;
          break;
        }
        j += 1;
      }
      out += text.slice(i, j);
      i = j;
      continue;
    }
    if (c === '}' || c === ']') {
      let k = out.length - 1;
      while (k >= 0 && /\s/.test(out[k])) k -= 1;
      if (k >= 0 && out[k] === ',') out = out.slice(0, k) + out.slice(k + 1);
      out += c;
      i += 1;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

export function readJsoncOrError(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      return { ok: false, code: 'ENOENT', reason: `${file} does not exist` };
    }
    return {
      ok: false,
      code: error.code ?? 'EREAD',
      reason: `${file} could not be read (${error.message})`,
    };
  }
  try {
    return { ok: true, value: JSON.parse(stripJsonc(text)) };
  } catch (error) {
    return {
      ok: false,
      code: 'EPARSE',
      reason: `${file} is not parseable as JSON even after JSONC comments and trailing commas are stripped (${error.message}), so the file itself is malformed rather than merely commented`,
    };
  }
}
