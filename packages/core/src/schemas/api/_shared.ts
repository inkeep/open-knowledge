import { z } from 'zod';
import { isDisallowedContentControl } from '../../util/content-controls.ts';
import { validateDocName } from '../../util/doc-name.ts';

export function checkAgentContent(
  value: string,
  context: z.RefinementCtx,
  path: string[] = [],
): void {
  for (let offset = 0; offset < value.length; offset++) {
    const codePoint = value.charCodeAt(offset);
    if (isDisallowedContentControl(codePoint)) {
      context.addIssue({
        code: 'custom',
        path,
        params: { contentControlAdmission: true },
        message: `Disallowed content control U+${codePoint.toString(16).toUpperCase().padStart(4, '0')} at zero-based UTF-16 offset ${offset}. C0 controls allow only TAB, LF and CR. Remove the character or replace it with a printable escape such as \\u0000.`,
      });
      return;
    }
  }
}

export const agentContentField = z.string().superRefine(checkAgentContent);

function checkDocName(value: string, ctx: z.RefinementCtx): void {
  const result = validateDocName(value);
  if (!result.ok) {
    ctx.addIssue({ code: 'custom', message: result.reason });
  }
}

export const safeDocNameField = z.string().superRefine(checkDocName).optional();

export const requiredSafeDocNameField = z.string().superRefine(checkDocName);

export const agentIdentityFields = {
  agentId: z.string().optional(),
  agentName: z.string().optional(),
  colorSeed: z.string().optional(),
  clientName: z.string().optional(),
  clientVersion: z.string().optional(),
  label: z.string().optional(),
};

export const summaryField = z.string().optional();

export const URN_UUID_RE =
  /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
