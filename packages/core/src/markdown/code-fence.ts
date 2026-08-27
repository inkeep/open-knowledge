export function selectFenceChar(info: string): '`' | '~' {
  return info.includes('`') ? '~' : '`';
}

export function widenFenceLength(fenceChar: '`' | '~', body: string, minLength = 3): number {
  const closerRe = new RegExp(`^ {0,3}(\\${fenceChar}+)[ \\t]*$`);
  let len = Math.max(3, minLength);
  for (const line of body.split('\n')) {
    const run = closerRe.exec(line);
    if (run && run[1].length >= len) len = run[1].length + 1;
  }
  return len;
}
