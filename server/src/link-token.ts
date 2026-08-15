import { randomBytes, randomUUID } from 'node:crypto';
import { sha256, Store } from './db.js';

const nameArg = process.argv.find((a) => a.startsWith('--name='));
const name = nameArg ? nameArg.slice('--name='.length) : (process.argv[2] ?? 'devcontainer');

const store = new Store();
const token = randomBytes(24).toString('hex');
store.createLink(randomUUID(), 'default', name, sha256(token));
store.close();

console.log(`Link agent token for "${name}" (store securely, used by PA_TOKEN):`);
console.log(token);
