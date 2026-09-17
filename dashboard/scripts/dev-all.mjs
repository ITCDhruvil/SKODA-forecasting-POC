import { spawn } from 'node:child_process';

function run(name, cmd, args) {
  const child = spawn(cmd, args, { stdio: 'inherit', shell: process.platform === 'win32' });
  child.on('exit', (code) => {
    console.log(`[${name}] exited with code ${code}`);
    shutdown(code ?? 0);
  });
  return child;
}

const children = [];

function shutdown(code = 0) {
  for (const child of children) child.kill();
  process.exit(code);
}

children.push(run('vite', 'npx', ['vite']));
children.push(run('api', 'npx', ['tsx', 'watch', 'scripts/dev-api-server.mjs']));

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
