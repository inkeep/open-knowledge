import type { IncomingMessage } from 'node:http';
import busboy from 'busboy';

export type MultipartParser = ReturnType<typeof createMultipartParser>;

export function createMultipartParser(req: IncomingMessage, limits: busboy.Limits): busboy.Busboy {
  return busboy({
    headers: req.headers,
    defParamCharset: 'utf8',
    limits,
  });
}
