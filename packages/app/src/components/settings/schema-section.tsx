import {
  CONFIG_DOC_NAME_PROJECT,
  CONFIG_DOC_NAME_USER,
  type Config,
  type ConfigBinding,
  humanFormat,
} from '@inkeep/open-knowledge-core';
import { useEffect, useRef, useState } from 'react';
import type { FieldPath } from 'react-hook-form';
import { toast } from 'sonner';
import { Form } from '@/components/ui/form';
import { subscribeToConfigValidationRejected } from '@/lib/config-validation-events';
import { firstIssuePath, type Scope, SettingsField } from './field-controls';
import type { SettingsScope } from './ScopeBadge';
import { SettingsSectionHeader } from './SettingsSectionHeader';
import type { FieldDef } from './settings-fields';
import { pickFirstIssueForPath, useConfigForm } from './use-config-form';

interface BoundSchemaSectionProps {
  title: string;
  description: string;
  scope: Scope;
  binding: ConfigBinding;
  fields: FieldDef[];
  scopeBadge: SettingsScope;
}

export function BoundSchemaSection({
  title,
  description,
  scope,
  binding,
  fields,
  scopeBadge,
}: BoundSchemaSectionProps) {
  const { form, commitField } = useConfigForm(binding);
  const [flashedPath, setFlashedPath] = useState<string | null>(null);
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const docName = scope === 'project' ? CONFIG_DOC_NAME_PROJECT : CONFIG_DOC_NAME_USER;
    const unsubscribe = subscribeToConfigValidationRejected((event) => {
      if (event.docName !== docName) return;

      toast.error(humanFormat(event.error), { duration: 8000 });

      const path = firstIssuePath(event.error);
      if (path) {
        form.setError(path as FieldPath<Config>, {
          type: 'config-validation-rejected',
          message: pickFirstIssueForPath(event.error, path),
        });
        form.setFocus(path as FieldPath<Config>);
        setFlashedPath(path);
        if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
        flashTimerRef.current = setTimeout(() => {
          setFlashedPath(null);
          form.clearErrors(path as FieldPath<Config>);
        }, 600);
      }
    });
    return () => {
      unsubscribe();
      if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
    };
  }, [scope, form]);

  return (
    <Form {...form}>
      <SchemaSection
        title={title}
        description={description}
        scope={scope}
        scopeBadge={scopeBadge}
        fields={fields}
        commitField={commitField}
        flashedPath={flashedPath}
      />
    </Form>
  );
}

interface SchemaSectionProps {
  title: string;
  description: string;
  scope: Scope;
  scopeBadge: SettingsScope;
  fields: FieldDef[];
  commitField: (name: FieldPath<Config>) => boolean;
  flashedPath: string | null;
}

function SchemaSection({
  title,
  description,
  scope,
  scopeBadge,
  fields,
  commitField,
  flashedPath,
}: SchemaSectionProps) {
  const titleId = `settings-section-${scope}-title`;
  return (
    <section aria-labelledby={titleId} className="space-y-3">
      <SettingsSectionHeader titleId={titleId} title={title} scope={scopeBadge}>
        {description}
      </SettingsSectionHeader>
      <div className="space-y-10">
        {fields.map((field) => (
          <SettingsField
            key={field.path.join('.')}
            field={field}
            scope={scope}
            commitField={commitField}
            isFlashed={flashedPath === field.path.join('.')}
          />
        ))}
      </div>
    </section>
  );
}
