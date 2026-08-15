import { Store } from './db.js';

/**
 * Admin CLI over the orchestrator DB (same direct-Store pattern as pair.ts).
 * Dev:  npx tsx src/admin.ts list-devices
 * Prod: node dist/admin.js list-devices
 */

function pad(s: string, len: number): string {
  return s.length >= len ? s : s + ' '.repeat(len - s.length);
}

function cut(s: string, len: number): string {
  return s.length > len ? `${s.slice(0, len - 1)}…` : s;
}

export function listDevices(store: Store): void {
  const rows = store.listDevices('default');
  console.log(`${rows.length} device(s):`);
  console.log(`${pad('ID', 39)}${pad('NAME', 22)}ENROLLED_AT`);
  for (const d of rows) {
    console.log(`${pad(d.id, 39)}${pad(cut(d.name, 21), 22)}${d.enrolled_at}`);
  }
}

export function revokeDevice(store: Store, id: string): void {
  if (!store.deleteDevice(id)) {
    console.log(`device ${id}: not found`);
    return;
  }
  console.log(`device ${id}: revoked`);
  console.log('note: the CLI is a separate process - live WS connections drop on next reconnect/restart');
}

export function listLinks(store: Store): void {
  const rows = store.listLinks('default');
  console.log(`${rows.length} link(s):`);
  console.log(`${pad('ID', 39)}${pad('NAME', 22)}CREATED_AT`);
  for (const l of rows) {
    console.log(`${pad(l.id, 39)}${pad(cut(l.name, 21), 22)}${l.created_at}`);
  }
}

export function revokeLink(store: Store, id: string): void {
  if (!store.deleteLink(id)) {
    console.log(`link ${id}: not found`);
    return;
  }
  console.log(`link ${id}: revoked`);
  console.log('note: the CLI is a separate process - live WS connections drop on next reconnect/restart');
}

function usage(): void {
  console.log('usage: admin.ts list-devices | revoke-device <id> | list-links | revoke-link <id>');
}

function main(): void {
  const [cmd, arg] = process.argv.slice(2);
  const store = new Store();
  try {
    switch (cmd) {
      case 'list-devices':
        listDevices(store);
        break;
      case 'revoke-device':
        if (!arg) usage();
        else revokeDevice(store, arg);
        break;
      case 'list-links':
        listLinks(store);
        break;
      case 'revoke-link':
        if (!arg) usage();
        else revokeLink(store, arg);
        break;
      default:
        usage();
    }
  } finally {
    store.close();
  }
}

const argv1 = process.argv[1] ?? '';
if (argv1.endsWith('admin.ts') || argv1.endsWith('admin.js')) {
  main();
}
