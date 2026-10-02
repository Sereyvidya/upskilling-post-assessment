import { condition, defineQuery, defineUpdate, setHandler } from '@temporalio/workflow';
import { applyCommand, expireDue, initialState, nextDeadline } from './model';
import type { Command, CommandResult, SalonState } from './types';

export const salonState = defineQuery<SalonState>('salonState');
export const command = defineUpdate<CommandResult, [Command]>('command');

// A single durable coordinator serializes changes across this small salon.
// No external side effects occur in this Workflow: notices are simulation data.
export async function salonWorkflow(): Promise<void> {
  const state = initialState();
  setHandler(salonState, () => state);
  setHandler(command, cmd => applyCommand(state, cmd, Date.now()));
  while (true) {
    expireDue(state, Date.now());
    const version = state.version;
    const deadline = nextDeadline(state);
    if (deadline === undefined) await condition(() => state.version !== version);
    else await condition(() => state.version !== version, Math.max(1, deadline - Date.now()));
  }
}
