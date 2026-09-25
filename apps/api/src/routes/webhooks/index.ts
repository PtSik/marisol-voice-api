import { Hono } from 'hono';
import { verifyElevenLabsSignature } from '../../middleware/verify-elevenlabs-signature';
import type { WorkerBindings } from '../../types';
import { handlePersonalization } from './personalization';
import { handlePostCall } from './post-call';

export const webhookRoutes = new Hono<{ Bindings: WorkerBindings }>();

webhookRoutes.post('/personalization', verifyElevenLabsSignature, handlePersonalization);

webhookRoutes.post('/post-call', verifyElevenLabsSignature, handlePostCall);
