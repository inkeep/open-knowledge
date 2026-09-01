export function createCodeFenceTracker(): (line: string) => boolean {
  let inFence = false;
  let openChar = '';
  let openLen = 0;

  return (line: string): boolean => {
    const fence = parseCodeFenceLine(line);
    if (inFence) {
      if (fence && fence.char === openChar && fence.len >= openLen && !fence.hasInfo) {
        inFence = false;
        openChar = '';
        openLen = 0;
      }
      return true;
    }
    if (fence) {
      inFence = true;
      openChar = fence.char;
      openLen = fence.len;
      return true;
    }
    return false;
  };
}

function parseCodeFenceLine(line: string): { char: string; len: number; hasInfo: boolean } | null {
  const stripped = line.endsWith('\r') ? line.slice(0, -1) : line;
  const m = stripped.match(/^ {0,3}([`~])(\1{2,})(.*)$/);
  if (!m) return null;
  return {
    char: m[1] as string,
    len: 1 + (m[2] as string).length,
    hasInfo: (m[3] as string).trim() !== '',
  };
}
