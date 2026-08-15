import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentMode } from '@pocketagent/protocol';

export type PermissionValue = 'allow' | 'ask' | 'deny';
export type PermissionMap = Record<string, PermissionValue>;

const readAllow: PermissionMap = { read: 'allow', glob: 'allow', grep: 'allow', list: 'allow' };

export function permissionForMode(mode: AgentMode): PermissionMap {
  switch (mode) {
    case 'yolo':
    case 'auto':
      return {
        '*': 'allow',
        'git push*': 'deny',
        'bash.git push*': 'deny',
        'rm -rf *': 'deny',
        'bash.rm -rf *': 'deny',
      };
    case 'acceptEdits':
      return { ...readAllow, edit: 'allow', write: 'allow', bash: 'ask', webfetch: 'ask', '*': 'ask' };
    case 'ask':
      return { ...readAllow, '*': 'ask' };
  }
}

export function parsePermissionJson(json: string): PermissionMap {
  const parsed: unknown = JSON.parse(json);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('OPENCODE_PERMISSION must be a JSON object');
  }
  const out: PermissionMap = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (value === 'allow' || value === 'ask' || value === 'deny') out[key] = value;
    else throw new Error(`OPENCODE_PERMISSION["${key}"] must be allow|ask|deny`);
  }
  return out;
}

export interface OpencodeConfig {
  permission: PermissionMap;
  doom_loop?: 'allow';
}

export function buildConfig(permission: PermissionMap, mode: AgentMode): OpencodeConfig {
  return mode === 'yolo' || mode === 'auto' ? { permission, doom_loop: 'allow' } : { permission };
}

export function writeOpencodeConfig(workDir: string, permission: PermissionMap, mode: AgentMode): string {
  const path = join(workDir, 'opencode.json');
  writeFileSync(path, JSON.stringify(buildConfig(permission, mode), null, 2) + '\n');
  return path;
}
