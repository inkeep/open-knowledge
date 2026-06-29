
export type ClipboardSource =
  | 'vscode'
  | 'gfm'
  | 'pm-origin'
  | 'gdocs'
  | 'word'
  | 'gmail'
  | 'notion'
  | 'apple'
  | 'slack'
  | 'gsheets'
  | 'github'
  | 'generic'
  | 'markdown-text'
  | 'plaintext'
  | 'local';

export function detectSource(dt: DataTransfer | null): ClipboardSource {
  if (!dt) return 'plaintext';

  if (dt.types.includes('vscode-editor-data')) return 'vscode';
  if (dt.types.includes('text/x-gfm')) return 'gfm';

  const html = dt.getData('text/html');
  if (html) {
    if (/data-pm-slice/i.test(html)) return 'pm-origin';
    if (/docs-internal-guid-/i.test(html)) return 'gdocs';
    if (/xmlns:o="urn:schemas-microsoft-com:office/i.test(html)) return 'word';
    if (/<meta[^>]*Generator[^>]*Microsoft Word/i.test(html)) return 'word';
    if (/class="gmail_|class='gmail_/i.test(html)) return 'gmail';
    if (/notionvc:/i.test(html)) return 'notion';
    if (/Cocoa HTML Writer/i.test(html)) return 'apple';
    if (/c-message_kit__|c-message__|c-compose/i.test(html)) return 'slack';
    if (/google-sheets-html-origin/i.test(html)) return 'gsheets';
    if (/data-hovercard-type=/i.test(html)) return 'github';
    return 'generic';
  }
  return 'plaintext';
}
