
export function getCurrentDocName(): string | null {
  if (typeof window === 'undefined') return null;
  const match = window.location.hash.match(/^#\/([^?#]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}
