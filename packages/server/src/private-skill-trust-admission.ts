import type { Connection, Extension } from '@hocuspocus/server';
import {
  CONFIG_DOC_NAME_USER,
  ConfigSchema,
  okUserHomeDisplayPath,
} from '@inkeep/open-knowledge-core';
import { parseDocument } from 'yaml';
import * as Y from 'yjs';

const skillConfigSchema = ConfigSchema.pick({ skills: true });

function approvedOrigins(source: string): Set<string> | null {
  try {
    const yaml = parseDocument(source);
    if (yaml.errors.length > 0) return null;
    const parsed = skillConfigSchema.safeParse(yaml.toJS() ?? {});
    return parsed.success
      ? new Set(parsed.data.skills.trustedPrivateOrigins.filter((origin) => origin !== null))
      : null;
  } catch {
    return null;
  }
}

const rejectionReasons = {
  'invalid-config': 'Configuration updates must contain valid YAML configuration.',
  'unresolved-update':
    'Configuration updates must be fully synchronized; reconnect before retrying.',
  'invalid-update': 'Configuration updates must contain a valid serialized document update.',
  'new-private-origin': () =>
    `Edit ${okUserHomeDisplayPath('global.yml')} on the computer running OpenKnowledge to approve private website skill origins.`,
};

interface ConfigMessageLease {
  connection: Connection;
  processing: Promise<void>;
}

export function createPrivateSkillTrustAdmission(
  onRejected: (rejection: keyof typeof rejectionReasons) => void,
): Extension {
  const leases = new WeakMap<Y.Doc, ConfigMessageLease>();
  return {
    async beforeHandleMessage({ documentName, document, connection }) {
      if (documentName !== CONFIG_DOC_NAME_USER) return;
      await Promise.resolve();
      while (true) {
        const held = leases.get(document);
        if (held === undefined || held.connection === connection) break;
        await held.processing;
      }
      const processing = connection.waitForPendingMessages();
      if (leases.get(document)?.processing === processing) return;
      const lease = { connection, processing };
      leases.set(document, lease);
      const release = () => {
        if (leases.get(document) === lease) leases.delete(document);
      };
      void processing.then(release, release);
    },
    async beforeSync({ documentName, document, connection, type, payload }) {
      if (documentName !== CONFIG_DOC_NAME_USER || (type !== 1 && type !== 2)) return;
      const currentSource = document.getText('source').toString();
      const before = approvedOrigins(currentSource) ?? new Set();
      const preview = new Y.Doc();
      let rejection: keyof typeof rejectionReasons | undefined;
      try {
        Y.applyUpdate(preview, Y.encodeStateAsUpdate(document));
        try {
          Y.applyUpdate(preview, payload);
        } catch {
          rejection = 'invalid-update';
        }
        if (rejection === undefined) {
          const resultingSource = preview.getText('source').toString();
          const after = approvedOrigins(resultingSource);
          if (!Y.snapshotContainsUpdate(Y.snapshot(preview), payload))
            rejection = 'unresolved-update';
          else if (resultingSource !== currentSource && after === null)
            rejection = 'invalid-config';
          else if (after !== null && [...after].some((origin) => !before.has(origin)))
            rejection = 'new-private-origin';
        }
      } finally {
        preview.destroy();
      }
      if (rejection !== undefined) {
        connection.readOnly = true;
        onRejected(rejection);
        const refusal = rejectionReasons[rejection];
        const reason = typeof refusal === 'function' ? refusal() : refusal;
        throw Object.assign(new Error(reason), { code: 4403, reason });
      }
    },
  };
}
