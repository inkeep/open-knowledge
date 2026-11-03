export interface WorkflowCommand {
  command: string;
  properties: Record<string, string>;
  message: string;
}

const unescapeData = (text: string) =>
  text.replace(/%0D/g, '\r').replace(/%0A/g, '\n').replace(/%25/g, '%');

const unescapeProperty = (text: string) =>
  text
    .replace(/%0D/g, '\r')
    .replace(/%0A/g, '\n')
    .replace(/%3A/g, ':')
    .replace(/%2C/g, ',')
    .replace(/%25/g, '%');

export function parseWorkflowCommands(output: string): WorkflowCommand[] {
  const commands: WorkflowCommand[] = [];
  for (const raw of output.split('\n')) {
    const line = raw.replace(/\r$/, '').trimStart();
    if (!line.startsWith('::')) continue;
    const end = line.indexOf('::', 2);
    if (end === -1) continue;
    const head = line.slice(2, end);
    const space = head.indexOf(' ');
    const properties: Record<string, string> = {};
    if (space !== -1) {
      for (const pair of head.slice(space + 1).split(',')) {
        const equals = pair.indexOf('=');
        if (equals > 0)
          properties[pair.slice(0, equals)] = unescapeProperty(pair.slice(equals + 1));
      }
    }
    commands.push({
      command: space === -1 ? head : head.slice(0, space),
      properties,
      message: unescapeData(line.slice(end + 2)),
    });
  }
  return commands;
}
