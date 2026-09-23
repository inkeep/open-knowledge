export interface AppliedRuntimeSnapshot {
  source: 'server';
  revision: 1;
  effectiveSince: string;
  port: number;
  bind: string[];
  idleShutdown: string;
  externalUrl: string | null;
}

export interface ServerInspection {
  pid: number;
  projectRoot: string;
  serverInstanceId: string;
  runtime: AppliedRuntimeSnapshot | null;
}
