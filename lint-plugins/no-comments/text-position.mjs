function buildLineStarts(source) {
  const starts = [0];
  for (let i = 0; i < source.length; i += 1) {
    if (source.charCodeAt(i) === 10) starts.push(i + 1);
  }
  return starts;
}

function positionAt(lineStarts, offset) {
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lineStarts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return { line: lo + 1, column: offset - lineStarts[lo] + 1 };
}

function precededByCodeOnLine(source, offset) {
  for (let i = offset - 1; i >= 0 && source.charCodeAt(i) !== 10; i -= 1) {
    if (!/\s/.test(source[i])) return true;
  }
  return false;
}

export function commentFactory(source) {
  const lineStarts = buildLineStarts(source);
  return (kind, start, end) => {
    const { line, column } = positionAt(lineStarts, start);
    return {
      kind,
      text: source.slice(start, end),
      start,
      end,
      line,
      column,
      precededByCode: precededByCodeOnLine(source, start),
    };
  };
}
