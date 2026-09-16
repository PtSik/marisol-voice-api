import { Hono } from 'hono';
import type { WorkerBindings } from '../../types';
import { handleTwilioInbound } from './inbound';
import { handleTwilioSms } from './sms';

export const twilioRoutes = new Hono<{ Bindings: WorkerBindings }>();

twilioRoutes.post('/inbound', handleTwilioInbound);
twilioRoutes.post('/sms', handleTwilioSms);
