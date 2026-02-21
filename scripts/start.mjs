import { spawn } from 'node:child_process';

const appRole = process.env.APP_ROLE === 'worker' ? 'worker' : 'api';
const command = appRole === 'worker' ? ['workers/dist/index.js'] : ['api/dist/index.js'];

const child = spawn('node', command, { stdio: 'inherit' });

child.on('exit', (code) => {
  process.exit(code ?? 1);
});