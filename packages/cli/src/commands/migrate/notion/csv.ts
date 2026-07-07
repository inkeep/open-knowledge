/**
 * Minimal RFC 4180 CSV parser for Notion `*_all.csv` database exports.
 *
 * Hand-rolled (no dependency) because Notion's exports hit exactly the cases a
 * naive `split(',')` corrupts: quoted fields with embedded commas, `""` escaped
 * quotes, embedded newlines inside quoted cells, and a leading UTF-8 BOM on the
 * first header field. Empirically every `_all.csv` starts with a BOM and 121
 * cells across a real export carried embedded newlines.
 */

export interface ParsedCsv {
  header: string[];
  rows: string[][];
}

/**
 * Parse a CSV string into a header row plus data rows. Never throws on
 * well-formed-but-quirky input; a header-only file yields `rows: []`.
 */
export function parseCsv(input: string): ParsedCsv {
  // Strip a leading UTF-8 BOM (U+FEFF) so the first header name is clean.
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;

  const records: string[][] = [];
  let field = '';
  let record: string[] = [];
  let inQuotes = false;
  // Whether any character (including a bare separator) has been consumed for the
  // current record — distinguishes a real trailing field from the empty tail
  // left after a terminating newline.
  let started = false;

  const endField = () => {
    record.push(field);
    field = '';
  };
  const endRecord = () => {
    endField();
    records.push(record);
    record = [];
    started = false;
  };

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          // Escaped quote — consume both, emit one.
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
      started = true;
      continue;
    }

    if (c === '"') {
      inQuotes = true;
      started = true;
    } else if (c === ',') {
      endField();
      started = true;
    } else if (c === '\n') {
      endRecord();
    } else if (c === '\r') {
      // Swallow the paired \n of a CRLF so it is one record boundary.
      if (text[i + 1] === '\n') i++;
      endRecord();
    } else {
      field += c;
      started = true;
    }
  }
  // Flush a final record that had no trailing newline.
  if (started || field !== '') endRecord();

  const header = records.length > 0 ? (records[0] as string[]) : [];
  const rows = records.slice(1);
  return { header, rows };
}
