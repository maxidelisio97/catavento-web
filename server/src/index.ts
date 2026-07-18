import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from '@fastify/type-provider-zod';
import { config } from './config.js';
import paymentsPlugin from './plugins/payments.js';
import webhooksPlugin from './plugins/webhooks.js';

const app = Fastify({ logger: true }).withTypeProvider<ZodTypeProvider>();

app.setValidatorCompiler(validatorCompiler);
app.setSerializerCompiler(serializerCompiler);

app.get('/api/health', async () => ({ ok: true }));

app.register(paymentsPlugin, { prefix: '/api' });
app.register(webhooksPlugin, { prefix: '/api' });

app.setErrorHandler((err, _request, reply) => {
  app.log.error(err);
  reply.status(500).send({ error: 'internal_error' });
});

app.listen({ port: config.port, host: '0.0.0.0' }, (err) => {
  if (err) {
    app.log.error(err);
    process.exit(1);
  }
  app.log.info(`Payments server (${config.asaas.env}) listening on :${config.port}`);
});
