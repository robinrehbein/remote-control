/**
 * Side-effect module, imported first by index.ts: pins every outbound HTTP(S)
 * request of this process to the egress proxy whenever the container was
 * started with one (network policy 'allowlist' - see installEnvProxyDispatcher
 * in @pocketagent/protocol for why node needs the nudge). It sits in its own
 * file so the dispatcher stands before the SDK modules imported below it are
 * evaluated; a call inside index.ts would run only after all of them.
 *
 * Without proxy variables (policy 'open', direct internet) nothing is
 * installed and the process talks to the network exactly as it did before.
 */
import { EnvHttpProxyAgent, setGlobalDispatcher } from 'undici';
import { installEnvProxyDispatcher } from '@pocketagent/protocol';

const proxy = installEnvProxyDispatcher(process.env, () => {
  setGlobalDispatcher(new EnvHttpProxyAgent());
});

// One line per container start, so a session that cannot reach its provider can
// be told apart from one that never even tried the proxy (no line = no proxy).
if (proxy !== undefined) console.log(`[proxy] junie-shim: outbound HTTP(S) via ${proxy}`);
