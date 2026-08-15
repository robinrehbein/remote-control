import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentMode } from '@pocketagent/protocol';

export type PermissionValue = 'allow' | 'ask' | 'deny';
export type PermissionTree = Record<string, PermissionValue | Record<string, PermissionValue>>;
export type PermissionMap = PermissionTree;

const readAllow: PermissionMap = { read: 'allow', glob: 'allow', grep: 'allow', list: 'allow' };

export function permissionForMode(mode: AgentMode): PermissionMap {
  switch (mode) {
    case 'yolo':
    case 'auto':
      return {
        '*': 'allow',
        doom_loop: 'allow',
        // deny patterns must be nested under the tool permission; a flat
        // "git push*" key would never match (kilo matches key=permission, value=command pattern)
        bash: {
          'git push*': 'deny',
          'rm -rf *': 'deny',
        },
      };
    case 'acceptEdits':
      return { ...readAllow, edit: 'allow', write: 'allow', bash: 'ask', webfetch: 'ask', '*': 'ask' };
    case 'ask':
      return { ...readAllow, '*': 'ask' };
  }
}

function parseValue(key: string, value: unknown): PermissionValue | Record<string, PermissionValue> {
  if (value === 'allow' || value === 'ask' || value === 'deny') return value;
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const nested: Record<string, PermissionValue> = {};
    for (const [nestedKey, nestedValue] of Object.entries(value)) {
      if (nestedValue === 'allow' || nestedValue === 'ask' || nestedValue === 'deny') nested[nestedKey] = nestedValue;
      else throw new Error(`OPENCODE_PERMISSION["${key}"]["${nestedKey}"] must be allow|ask|deny`);
    }
    return nested;
  }
  throw new Error(`OPENCODE_PERMISSION["${key}"] must be allow|ask|deny or a nested map of those`);
}

export function parsePermissionJson(json: string): PermissionMap {
  const parsed: unknown = JSON.parse(json);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('OPENCODE_PERMISSION must be a JSON object');
  }
  const out: PermissionMap = {};
  for (const [key, value] of Object.entries(parsed)) {
    out[key] = parseValue(key, value);
  }
  return out;
}

export interface OpencodeConfig {
  permission: PermissionMap;
}

export function buildConfig(permission: PermissionMap, _mode: AgentMode): OpencodeConfig {
  // kilo rejects config files with unrecognized top-level keys (InvalidError =>
  // the whole file is skipped), so only send keys that exist in kilo's
  // ConfigV1 schema; doom_loop belongs inside `permission`.
  void _mode;
  return { permission };
}

export function writeOpencodeConfig(workDir: string, permission: PermissionMap, mode: AgentMode): string {
  const body = JSON.stringify(buildConfig(permission, mode), null, 2) + '\n';
  // kilo discovers project config for both names ("kilo" and "opencode" walk
  // up from the instance directory), so write both to be safe.
  const primary = join(workDir, 'kilo.json');
  writeFileSync(primary, body);
  writeFileSync(join(workDir, 'opencode.json'), body);
  return primary;
}
