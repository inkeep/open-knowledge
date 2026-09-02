export interface ParsedCsv {
  header: string[];
  rows: string[][];
}

export function parseCsv(input: string): ParsedCsv {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;

  const records: string[][] = [];
  let field = '';
  let record: string[] = [];
  let inQuotes = false;
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
      if (text[i + 1] === '\n') i++;
      endRecord();
    } else {
      field += c;
      started = true;
    }
  }
  if (started || field !== '') endRecord();

  const header = records.length > 0 ? (records[0] as string[]) : [];
  const rows = records.slice(1);
  return { header, rows };
}
