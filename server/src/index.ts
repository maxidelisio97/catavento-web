import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from '@fastify/type-provider-zod';
import cookie from '@fastify/cookie';
import { config } from './config.js';
import { registerErrorHandler } from './errorHandler.js';
import paymentsPlugin from './plugins/payments.js';
import webhooksPlugin from './plugins/webhooks.js';
import roomsPlugin from './plugins/rooms.js';
import availabilityPlugin from './plugins/availability.js';
import reservationsPlugin from './plugins/reservations.js';
import authPlugin from './plugins/auth.js';
import panelTapeChartPlugin from './plugins/panelTapeChart.js';
import panelSettingsPlugin from './plugins/panelSettings.js';
import panelRoomRatesPlugin from './plugins/panelRoomRates.js';
import panelReservationActionsPlugin from './plugins/panelReservationActions.js';
import panelMoveReservationPlugin from './plugins/panelMoveReservation.js';
import panelManualReservationPlugin from './plugins/panelManualReservation.js';

// trustProxy scoped to 127.0.0.1, not `true`: Nginx proxies here from
// loopback (see nginx.conf.example / nginx-panel.conf.example), so only
// requests actually arriving via that proxy get their X-Forwarded-For /
// X-Forwarded-Proto headers trusted. Without this, request.ip is always
// the proxy's own loopback address for every real client behind Nginx —
// which would silently collapse the per-IP login rate limiter
// (auth/loginRateLimiter.ts) into one shared bucket per email, and record
// 127.0.0.1 in sessions.ip for every login instead of the real client IP
// that SPEC-modulo-6-panel-base.md § 6B.3 requires logging. If port 3001
// is ever reachable directly (bypassing Nginx), a spoofed header from that
// path is ignored because it isn't from 127.0.0.1 — a bare `trustProxy:
// true` would trust it instead.
const app = Fastify({ logger: true, trustProxy: '127.0.0.1' }).withTypeProvider<ZodTypeProvider>();

app.setValidatorCompiler(validatorCompiler);
app.setSerializerCompiler(serializerCompiler);

// No `secret` — the panel session cookie carries the opaque bearer token
// directly (its hash is what's checked server-side in sessionRepository),
// so there's nothing here for @fastify/cookie's signing to protect.
app.register(cookie);

app.get('/api/health', async () => ({ ok: true }));

app.register(paymentsPlugin, { prefix: '/api' });
app.register(webhooksPlugin, { prefix: '/api' });
app.register(roomsPlugin, { prefix: '/api' });
app.register(availabilityPlugin, { prefix: '/api' });
app.register(reservationsPlugin, { prefix: '/api' });
app.register(authPlugin);
app.register(panelTapeChartPlugin);
app.register(panelSettingsPlugin);
app.register(panelRoomRatesPlugin);
app.register(panelReservationActionsPlugin);
app.register(panelMoveReservationPlugin);
app.register(panelManualReservationPlugin);

registerErrorHandler(app);

app.listen({ port: config.port, host: '127.0.0.1' }, (err) => {
  if (err) {
    app.log.error(err);
    process.exit(1);
  }
  app.log.info(`Payments server (${config.asaas.env}) listening on :${config.port}`);
});
