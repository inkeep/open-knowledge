const MAX_VERSION_LENGTH = 256;

const FIRST_PRINTABLE_ASCII = 0x20;
const LAST_PRINTABLE_ASCII = 0x7e;

export function asReportableAppVersion(value: string | null | undefined): string | null {
  if (typeof value !== 'string' || value === '' || value.length > MAX_VERSION_LENGTH) return null;
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < FIRST_PRINTABLE_ASCII || code > LAST_PRINTABLE_ASCII) return null;
  }
  return value;
}
