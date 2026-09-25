import { SupervisionFormatRegistry } from './supervision-format-registry.ts';
import { jsonV1Strategy } from './supervision-json-v1-strategy.ts';

export const supervisionFormats = new SupervisionFormatRegistry([jsonV1Strategy]);
