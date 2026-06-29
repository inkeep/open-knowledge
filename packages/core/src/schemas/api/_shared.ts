import { z } from 'zod';
import { validateDocName } from '../../util/doc-name.ts';

function checkDocName(value: string, ctx: z.RefinementCtx): void {
  const result = validateDocName(value);
  if (!result.ok) {
    ctx.addIssue({ code: 'custom', message: result.reason });
  }
}

export const safeDocNameField = z.string().superRefine(checkDocName).optional();

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
