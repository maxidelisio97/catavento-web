import express from 'express';
import { config } from './config.js';
import { paymentsRouter } from './routes/payments.js';
import { webhooksRouter } from './routes/webhooks.js';

const app = express();

app.use(express.json());

app.get('/api/health', (_req, res) => res.json({ ok: true }));

app.use('/api', paymentsRouter);
app.use('/api', webhooksRouter);

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'internal_error' });
});

app.listen(config.port, () => {
  console.log(`Payments server (${config.asaas.env}) listening on :${config.port}`);
});
