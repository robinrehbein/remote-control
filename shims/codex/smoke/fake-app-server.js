#!/usr/bin/env node
/**
 * Fake `codex app-server` for the codex-shim smoke test.
 *
 * Speaks the same newline-delimited JSON-RPC over stdio the real binary does,
 * so the shim's RealCodexRunner + JsonRpcEndpoint are exercised end to end
 * (spawn, handshake, thread/turn, server-initiated approvals, interrupt) with
 * no real Codex binary and no network. Node builtins only.
 *
 * Scripted turn (driven by the prompt text + approvalPolicy):
 *  - always: an assistant delta, then a shell command, then a final message
 *  - text contains "edit": also a file_change that writes hello.txt on accept
 *  - text contains "hang": stalls until turn/interrupt arrives
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

let buffer = '';
let serverReqId = 0;
const pendingServerReq = new Map();
let turnCounter = 0;
let hanging = null; // { turnId } when a turn is stalled waiting for interrupt

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let nl = buffer.indexOf('\n');
  while (nl !== -1) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (line) handleLine(line);
    nl = buffer.indexOf('\n');
  }
});

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function respond(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function notify(method, params) {
  send({ jsonrpc: '2.0', method, params });
}

/** Server-initiated request; resolves with the shim's decision result. */
function serverRequest(method, params) {
  const id = `srv-${++serverReqId}`;
  return new Promise((resolve) => {
    pendingServerReq.set(id, resolve);
    send({ jsonrpc: '2.0', id, method, params });
  });
}

function handleLine(line) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  // Response from the shim to one of our server requests (approvals).
  if ((msg.result !== undefined || msg.error !== undefined) && msg.id != null && pendingServerReq.has(msg.id)) {
    const resolve = pendingServerReq.get(msg.id);
    pendingServerReq.delete(msg.id);
    resolve(msg.error ? { decision: 'decline' } : msg.result ?? {});
    return;
  }
  if (typeof msg.method !== 'string') return;

  switch (msg.method) {
    case 'initialize':
      respond(msg.id, { protocolVersion: '1', serverInfo: { name: 'fake-codex', version: '0.0.0' } });
      return;
    case 'initialized':
    case 'shutdown':
      return; // notifications
    case 'thread/start':
      respond(msg.id, { threadId: 'thread-fake-1' });
      return;
    case 'thread/resume': {
      const threadId = (msg.params && msg.params.threadId) || 'thread-fake-1';
      respond(msg.id, { threadId });
      return;
    }
    case 'turn/start': {
      const turnId = `turn-${++turnCounter}`;
      respond(msg.id, { turnId });
      void runTurn(turnId, msg.params || {});
      return;
    }
    case 'turn/interrupt': {
      respond(msg.id, {});
      if (hanging) {
        const { turnId } = hanging;
        hanging = null;
        notify('turn/failed', { turnId, error: { message: 'turn interrupted' } });
      }
      return;
    }
    default:
      if (msg.id != null) respond(msg.id, {});
      return;
  }
}

function promptText(params) {
  const input = Array.isArray(params.input) ? params.input : [];
  return input.map((part) => (part && typeof part.text === 'string' ? part.text : '')).join(' ');
}

async function runTurn(turnId, params) {
  const text = promptText(params);
  const approvalPolicy = params.approvalPolicy || 'never';
  const cwd = params.cwd || process.cwd();
  const gated = approvalPolicy !== 'never';

  // 1) assistant delta
  notify('item/started', { item: { id: 'msg1', type: 'agent_message' } });
  notify('item/agentMessage/delta', { itemId: 'msg1', delta: 'Working on it. ' });

  if (text.includes('hang')) {
    hanging = { turnId };
    return; // stall until turn/interrupt
  }

  // 2) file change (only when asked to edit)
  if (text.includes('edit')) {
    notify('item/started', { item: { id: 'fc1', type: 'file_change', changes: [{ path: 'hello.txt' }] } });
    let accepted = true;
    if (gated) {
      const reply = await serverRequest('item/fileChange/requestApproval', {
        itemId: 'fc1',
        changes: [{ path: 'hello.txt' }],
      });
      accepted = reply.decision !== 'decline';
    }
    if (accepted) {
      try {
        writeFileSync(join(cwd, 'hello.txt'), 'hello from codex\n');
      } catch {
        /* ignore */
      }
      notify('item/completed', { item: { id: 'fc1', type: 'file_change', changes: [{ path: 'hello.txt' }] } });
    } else {
      notify('item/completed', { item: { id: 'fc1', type: 'file_change', error: 'declined' } });
    }
  }

  // 3) shell command
  notify('item/started', { item: { id: 'cmd1', type: 'command_execution', command: 'echo hi' } });
  let cmdOk = true;
  if (gated) {
    const reply = await serverRequest('item/commandExecution/requestApproval', {
      itemId: 'cmd1',
      command: 'echo hi',
    });
    cmdOk = reply.decision !== 'decline';
  }
  notify('item/completed', {
    item: {
      id: 'cmd1',
      type: 'command_execution',
      command: 'echo hi',
      aggregatedOutput: cmdOk ? 'hi\n' : 'declined',
      exitCode: cmdOk ? 0 : 1,
    },
  });

  // 4) final assistant message
  notify('item/completed', { item: { id: 'msg2', type: 'agent_message', text: 'Done.' } });

  // 5) turn done
  notify('turn/completed', { turnId, usage: { inputTokens: 10, outputTokens: 20 } });
}
