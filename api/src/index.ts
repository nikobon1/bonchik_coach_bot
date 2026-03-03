import { createLogger } from '@bonchik/shared';
import { startServer } from './server';

void startServer().catch((error) => {
  createLogger('api').fatal({ err: error }, 'API bootstrap failed');
  process.exit(1);
});
