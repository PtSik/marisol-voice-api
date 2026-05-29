import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { WorkerBindings } from './types';
import { adminRoutes } from './routes/admin';
import { toolRoutes } from './routes/tools';
import { twilioRoutes } from './routes/twilio';
import { webhookRoutes } from './routes/webhooks';

const app = new Hono<{ Bindings: WorkerBindings }>();

app.use('*', cors());

app.route('/webhooks', webhookRoutes);
app.route('/twilio', twilioRoutes);
app.route('/tools', toolRoutes);
app.route('/admin', adminRoutes);

export default {
  async fetch(req: Request, env: WorkerBindings, ctx: ExecutionContext): Promise<Response> {
    return app.fetch(req, env, ctx);
  },
} satisfies ExportedHandler<WorkerBindings>;
