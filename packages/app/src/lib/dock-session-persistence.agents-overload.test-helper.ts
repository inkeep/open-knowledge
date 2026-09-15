import { type WebAgentsDockSessionOrder, writeDockSessionOrder } from './dock-session-persistence';

export function writeAgentsOrderFromStoredRecord(record: WebAgentsDockSessionOrder): void {
  // @ts-expect-error the agents overload must reject agentPanelVisible structurally, so a variable already typed as a stored record cannot smuggle a level through the order writer
  writeDockSessionOrder(null, 'agents', record);
}
