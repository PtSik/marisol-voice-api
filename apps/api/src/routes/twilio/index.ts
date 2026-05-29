import { Hono } from 'hono';
import type { WorkerBindings } from '../../types';
import { handleTwilioInbound } from './inbound';

export const twilioRoutes = new Hono<{ Bindings: WorkerBindings }>();

twilioRoutes.post('/inbound', handleTwilioInbound);
