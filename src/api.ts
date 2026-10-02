import path from 'node:path';
import { Client, Connection, WorkflowExecutionAlreadyStartedError } from '@temporalio/client';
import express, { type NextFunction, type Request, type Response } from 'express';
import type { Command, CommandResult, SalonState } from './types';

const app = express();
const workflowId = 'juniper-salon-v1';
let ready: Promise<Client> | undefined;
async function getClient(): Promise<Client> {
  ready ??= (async () => {
    const connection = await Connection.connect({ address: process.env.TEMPORAL_ADDRESS ?? 'localhost:7233' });
    const client = new Client({ connection, namespace: 'default' });
    try { await client.workflow.start('salonWorkflow', { workflowId, taskQueue: 'assessment-starter', args: [] }); }
    catch (error) { if (!(error instanceof WorkflowExecutionAlreadyStartedError)) throw error; }
    return client;
  })().catch(error => { ready = undefined; throw error; });
  return ready;
}
app.use(express.json({ limit: '32kb' }));
app.use(express.static(path.join(process.cwd(), 'public')));
app.get('/api/state', async (_req, res) => {
  const client = await getClient();
  const handle = client.workflow.getHandle(workflowId);
  const state = await handle.query<SalonState>('salonState');
  res.json({ ...state, workflowId });
});

function validate(value: unknown): Command {
  if (!value || typeof value !== 'object') throw new Error('A command object is required.');
  const c = value as Record<string, unknown>;
  const str = (key: string, max = 300): string => {
    if (typeof c[key] !== 'string' || !(c[key] as string).trim() || (c[key] as string).length > max) throw new Error(`Invalid ${key}.`);
    return (c[key] as string).trim();
  };
  const choice = <T extends string>(key: string, options: readonly T[]): T => {
    if (!options.includes(c[key] as T)) throw new Error(`Invalid ${key}.`);
    return c[key] as T;
  };
  if (c.type === 'create') {
    const id = str('id', 80);
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error('Invalid opening id.');
    const service = choice('service', ['Haircut', 'Color'] as const);
    const stylist = choice('stylist', ['Maya', 'Jo'] as const);
    const mode = choice('mode', ['demo', 'standard'] as const);
    if (typeof c.duration !== 'number' || ![30, 60, 90].includes(c.duration)) throw new Error('Duration must be 30, 60 or 90 minutes.');
    if (typeof c.startsAt !== 'number' || !Number.isSafeInteger(c.startsAt)) throw new Error('Invalid appointment date.');
    const when = new Date(c.startsAt);
    const now = new Date();
    if (when.toDateString() !== now.toDateString() || c.startsAt <= Date.now()) throw new Error('This prototype supports future openings today, in the salon computer’s local timezone.');
    const localTime = `${String(when.getHours()).padStart(2, '0')}:${String(when.getMinutes()).padStart(2, '0')}`;
    if (c.localTime !== localTime) throw new Error('Appointment time does not match the local date.');
    if (typeof c.failDelivery !== 'boolean') throw new Error('Invalid delivery simulation setting.');
    return { type: 'create', id, service, stylist, duration: c.duration, startsAt: c.startsAt, localTime, mode, failDelivery: c.failDelivery };
  }
  if (c.type === 'reply') return { type: 'reply', openingId: str('openingId', 80), offerId: str('offerId', 120), response: choice('response', ['accept', 'decline', 'question', 'stop'] as const), message: typeof c.message === 'string' ? c.message.slice(0, 300) : undefined };
  if (c.type === 'staff') return { type: 'staff', openingId: str('openingId', 80), action: choice('action', ['retry', 'skip', 'cancel', 'phone', 'confirm'] as const), reason: typeof c.reason === 'string' ? c.reason.slice(0, 300) : undefined };
  throw new Error('Unknown command.');
}
app.post('/api/command', async (req, res) => {
  let cmd: Command;
  try { cmd = validate(req.body); }
  catch (error) { res.status(400).json({ ok: false, message: (error as Error).message }); return; }
  const client = await getClient();
  const result = await client.workflow.getHandle(workflowId).executeUpdate<CommandResult, [Command]>('command', { args: [cmd] });
  res.status(result.ok ? 200 : 409).json(result);
});
app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  console.error(error);
  res.status(503).json({ ok: false, message: 'The durable service is unavailable. No success was confirmed. Check the latest state before retrying.' });
});
const port = Number(process.env.PORT ?? 3000);
app.listen(port, '127.0.0.1', () => console.log(`Juniper Salon prototype: http://localhost:${port}`));
