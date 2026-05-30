import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { adminRoutes } from './routes/admin';
import { toolRoutes } from './routes/tools';
import { twilioRoutes } from './routes/twilio';
import { webhookRoutes } from './routes/webhooks';
import type { WorkerBindings } from './types';

const app = new Hono<{ Bindings: WorkerBindings }>();

app.onError((err, c) => {
  console.error(`[onError] ${c.req.method} ${c.req.path}:`, err);
  if (err instanceof HTTPException) return err.getResponse();
  // Tool webhooks must answer in tool shape — an unhandled throw would otherwise
  // surface to the caller as dead air on the line.
  if (c.req.path.startsWith('/tools/')) {
    return c.json(
      {
        result: 'Sorry, I ran into a problem with that. Could you try again in a moment?',
        success: false,
      },
      200,
    );
  }
  return c.json({ error: 'Internal Server Error' }, 500);
});

app.route('/webhooks', webhookRoutes);
app.route('/twilio', twilioRoutes);
app.route('/tools', toolRoutes);
app.route('/admin', adminRoutes);

export default {
  async fetch(req: Request, env: WorkerBindings, ctx: ExecutionContext): Promise<Response> {
    return app.fetch(req, env, ctx);
  },
} satisfies ExportedHandler<WorkerBindings>;
