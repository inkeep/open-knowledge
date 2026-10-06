const EXPRESSION = /\$\{\{([\s\S]*?)\}\}/g;

function expressionsIn(value, key) {
  if (typeof value === 'string') {
    if (key === 'if') return [value.trim()];
    return [...value.matchAll(EXPRESSION)].map((match) => match[1].trim());
  }
  if (Array.isArray(value)) return value.flatMap((item) => expressionsIn(item));
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).flatMap(([name, item]) => expressionsIn(item, name));
  }
  return [];
}

export function credentialReasons(workflow, job) {
  const reasons = [];
  const permissions = job.permissions ?? workflow.permissions;
  if (permissions === undefined || permissions === null) reasons.push('default token permissions');
  else if (permissions === 'write-all') reasons.push('write-all');
  else if (typeof permissions === 'object') {
    for (const [scope, level] of Object.entries(permissions)) {
      if (level === 'write') reasons.push(`${scope}: write`);
    }
  }
  for (const expr of [...expressionsIn(job), ...expressionsIn(workflow.env ?? {})]) {
    if (/\bsecrets\b/i.test(expr.replace(/\bsecrets\.GITHUB_TOKEN\b/gi, ''))) {
      reasons.push(`secret: ${expr}`);
    }
  }
  if (job.secrets === 'inherit') reasons.push('secrets: inherit');
  if ((job.steps ?? []).some((step) => step.uses?.startsWith('actions/create-github-app-token@'))) {
    reasons.push('App token');
  }
  return reasons;
}

export const holdsCredential = (workflow, job) => credentialReasons(workflow, job).length > 0;
