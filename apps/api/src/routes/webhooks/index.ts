import { Hono } from 'hono';
import { verifyElevenLabsSignature } from '../../middleware/verify-elevenlabs-signature';
import type { WorkerBindings } from '../../types';
import { handlePersonalization } from './personalization';
import { handlePostCall } from './post-call';

export const webhookRoutes = new Hono<{ Bindings: WorkerBindings }>();

webhookRoutes.post(
  '/personalization',
  (c, next) => verifyElevenLabsSignature(c.env.ELEVENLABS_WEBHOOK_SECRET)(c, next),
  handlePersonalization,
);

webhookRoutes.post(
  '/post-call',
  (c, next) => verifyElevenLabsSignature(c.env.ELEVENLABS_WEBHOOK_SECRET)(c, next),
  handlePostCall,
);
