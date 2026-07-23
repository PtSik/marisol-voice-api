import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { runCalendarAlerts } from './lib/calendar-alerts';
import { runCalendarSync } from './lib/calendar-sync';
import { runReminders } from './lib/reminders';
import { adminRoutes } from './routes/admin';
import { googleIntegrationRoutes } from './routes/integrations/google';
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
app.route('/integrations/google', googleIntegrationRoutes);

export default {
  async fetch(req: Request, env: WorkerBindings, ctx: ExecutionContext): Promise<Response> {
    return app.fetch(req, env, ctx);
  },
  async scheduled(controller: ScheduledController, env: WorkerBindings, ctx: ExecutionContext) {
    if (controller.cron === '*/15 * * * *') {
      ctx.waitUntil(
        runCalendarSync(env)
          .then((r) => console.log('[gcal-sync] tick:', JSON.stringify(r)))
          .catch((err) => console.error('[gcal-sync] tick failed:', err)),
      );
      return;
    }
    // allSettled, not all: a failing alert send must not take the reminders down with it.
    ctx.waitUntil(
      Promise.allSettled([
        runReminders(env).then((r) => console.log('[reminders] tick:', JSON.stringify(r))),
        runCalendarAlerts(env).then((r) => console.log('[gcal-alert] tick:', JSON.stringify(r))),
      ]),
    );
  },
} satisfies ExportedHandler<WorkerBindings>;
