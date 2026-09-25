import { createApiServer } from './index.js';
import { pool } from '../db/transaction.js';

const port = Number(process.env.PORT ?? '3000');
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');
const server = createApiServer();
server.on('error', () => {
  console.error('API server failed');
  void pool.end().finally(() => { process.exitCode = 1; });
});
server.listen(port, process.env.HOST ?? '127.0.0.1', () => console.log(`Read API listening on port ${port}`));
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    const timeout = setTimeout(() => process.exit(1), 10000);
    timeout.unref();
    server.close(() => { void pool.end().finally(() => clearTimeout(timeout)); });
  });
}
