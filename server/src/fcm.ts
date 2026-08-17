import { createSign } from 'node:crypto';
import type { FcmPushPayload } from '@pocketagent/protocol';

interface ServiceAccount {
  project_id: string;
  client_email: string;
  private_key: string;
  token_uri?: string;
}

const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
let cachedAccount: ServiceAccount | null | undefined;
let cachedToken: { token: string; exp: number } | null = null;

function b64url(input: string | Buffer): string {
  return Buffer.from(input).toString('base64url');
}

function account(): ServiceAccount | null {
  if (cachedAccount === undefined) {
    const raw = process.env.FCM_SERVICE_ACCOUNT_JSON;
    if (!raw) {
      cachedAccount = null;
    } else {
      try {
        const parsed = JSON.parse(raw) as ServiceAccount;
        cachedAccount =
          parsed.project_id && parsed.client_email && parsed.private_key ? parsed : null;
      } catch {
        cachedAccount = null;
      }
    }
  }
  return cachedAccount;
}

function makeJwt(sa: ServiceAccount): string {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const claims = {
    iss: sa.client_email,
    scope: SCOPE,
    aud: sa.token_uri ?? 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  };
  const unsigned = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
  const signer = createSign('RSA-SHA256');
  signer.update(unsigned);
  const sig = signer.sign(sa.private_key);
  return `${unsigned}.${b64url(sig)}`;
}

async function accessToken(sa: ServiceAccount): Promise<string> {
  if (cachedToken && cachedToken.exp > Date.now() / 1000 + 60) return cachedToken.token;
  const tokenUri = sa.token_uri ?? 'https://oauth2.googleapis.com/token';
  const res = await fetch(tokenUri, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: makeJwt(sa),
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`fcm oauth failed: ${res.status}`);
  const data = (await res.json()) as { access_token: string; expires_in: number };
  cachedToken = { token: data.access_token, exp: Date.now() / 1000 + data.expires_in };
  return data.access_token;
}

export async function sendPush(tokens: string[], payload: FcmPushPayload): Promise<void> {
  const sa = account();
  if (!sa) {
    console.log(
      `[fcm:dry-run] ${payload.eventType} session=${payload.sessionId.slice(0, 8)} "${payload.title}"`,
    );
    return;
  }
  const token = await accessToken(sa);
  await Promise.all(
    tokens.map(async (t) => {
      try {
        const res = await fetch(
          `https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`,
          {
            method: 'POST',
            headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
            body: JSON.stringify({
              message: {
                token: t,
                notification: { title: payload.title, body: payload.body },
                data: {
                  sessionId: payload.sessionId,
                  eventType: payload.eventType,
                  ...(payload.permissionId ? { permissionId: payload.permissionId } : {}),
                },
              },
            }),
            signal: AbortSignal.timeout(10_000),
          },
        );
        if (!res.ok) console.error(`[fcm] send failed: ${res.status}`);
      } catch (e) {
        console.error(`[fcm] send error: ${String(e)}`);
      }
    }),
  );
}
