import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type Redis from 'ioredis';

export type ScriptName =
  | 'enqueue'
  | 'enqueue-batch'
  | 'enqueue-flow'
  | 'reserve'
  | 'reserve-batch'
  | 'reserve-atomic'
  | 'complete-job'
  | 'complete-and-reserve-next-with-metadata'
  | 'retry'
  | 'heartbeat'
  | 'promote-delayed'
  | 'promote-staged'
  | 'change-delay'
  | 'get-queue-metrics'
  | 'get-jobs'
  | 'get-unique-groups'
  | 'get-unique-groups-count'
  | 'cleanup-poisoned-group'
  | 'remove'
  | 'clean-status'
  | 'is-empty'
  | 'dead-letter'
  | 'check-stalled'
  | 'repair-groups';

const cacheByClient = new WeakMap<Redis, Map<ScriptName, string>>();
const metadataCache = new Map<string, ScriptMetadata>();

// Regex to match @include directives: --- @include "path" or -- @include "path"
const INCLUDE_REGEX = /^[-]{2,3}[ \t]*@include[ \t]+(["'])(.+?)\1[; \t\n]*$/gm;

interface ScriptMetadata {
  name: string;
  path: string;
  content: string;
  dependencies: ScriptMetadata[];
}

function scriptPath(name: ScriptName): string {
  // Resolve Lua script path in both dev (TS) and prod (dist) builds.
  const currentDir = path.dirname(fileURLToPath(import.meta.url));

  const candidates = [
    // Dev: alongside loader.ts (src/lua/<name>.lua)
    path.join(currentDir, `${name}.lua`),
    // Prod: dist/lua/<name>.lua adjacent to built bundle directory
    path.join(currentDir, 'lua', `${name}.lua`),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  // Fallback to first candidate; read will throw a helpful error if missing
  return candidates[0];
}

function resolveLuaPath(includePath: string): string {
  // Resolve both dev and prod locations for include files
  const currentDir = path.dirname(fileURLToPath(import.meta.url));

  const candidates = [
    // Dev: src/lua/<includePath>.lua
    path.join(currentDir, `${includePath}.lua`),
    // Prod: dist/lua/<includePath>.lua
    path.join(currentDir, 'lua', `${includePath}.lua`),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }

  throw new Error(`Include file not found: ${includePath} (tried: ${candidates.join(', ')})`);
}

function parseIncludes(content: string): string[] {
  const matches = Array.from(content.matchAll(INCLUDE_REGEX));
  return matches.map(m => m[2]);
}

function loadScriptWithDependencies(
  scriptPath: string,
  visited = new Set<string>(),
): ScriptMetadata {
  const normalized = path.normalize(scriptPath);

  // Return cached metadata if available
  if (metadataCache.has(normalized)) {
    return metadataCache.get(normalized)!;
  }

  // Detect circular dependency
  if (visited.has(normalized)) {
    throw new Error(`Circular dependency detected: ${normalized}`);
  }

  visited.add(normalized);

  if (!fs.existsSync(normalized)) {
    throw new Error(`Script not found: ${normalized}`);
  }

  const content = fs.readFileSync(normalized, 'utf8');
  const includes = parseIncludes(content);
  const dependencies: ScriptMetadata[] = [];

  for (const includePath of includes) {
    const depPath = resolveLuaPath(includePath);
    const dep = loadScriptWithDependencies(depPath, new Set(visited));
    dependencies.push(dep);
  }

  const metadata: ScriptMetadata = {
    name: path.basename(normalized, '.lua'),
    path: normalized,
    content,
    dependencies,
  };

  metadataCache.set(normalized, metadata);
  return metadata;
}

function mergeScripts(metadata: ScriptMetadata): string {
  const processed = new Set<string>();
  const merged: string[] = [];

  function collectScripts(meta: ScriptMetadata) {
    if (processed.has(meta.path)) return;
    processed.add(meta.path);

    // Process dependencies first (topological sort)
    for (const dep of meta.dependencies) {
      collectScripts(dep);
    }

    // Add the script content without @include directives
    const content = meta.content.replace(INCLUDE_REGEX, '').trim();
    if (content) {
      merged.push(content);
    }
  }

  collectScripts(metadata);

  // Join and clean up multiple blank lines
  return merged.join('\n\n').replace(/\n\s*\n\s*\n/g, '\n\n');
}

export async function loadScript(
  client: Redis,
  name: ScriptName,
): Promise<string> {
  let map = cacheByClient.get(client);
  if (!map) {
    map = new Map();
    cacheByClient.set(client, map);
  }
  const cached = map.get(name);
  if (cached) return cached;

  const file = scriptPath(name);

  // Load the script with all dependencies resolved
  const metadata = loadScriptWithDependencies(file);
  const luaCode = mergeScripts(metadata);

  const sha = await (client as any).script('load', luaCode);
  map.set(name, sha as string);
  return sha as string;
}

export async function evalScript<T = any>(
  client: Redis,
  name: ScriptName,
  argv: Array<string>,
  numKeys: number,
): Promise<T> {
  const execute = async (): Promise<T> => {
    const sha = await loadScript(client, name);
    return await (client as any).evalsha(sha, numKeys, ...argv);
  };

  try {
    try {
      // First attempt
      return await execute();
    } catch (err: any) {
      // Handle NOSCRIPT: clear cache and retry once
      if (err.message?.includes('NOSCRIPT')) {
        const map = cacheByClient.get(client);
        if (map) map.delete(name);
        return await execute();
      }
      throw err;
    }
  } catch (err: any) {
    // Unified error handling: inject script name for debugging
    if (err instanceof Error) {
      // Avoid duplicate prefix
      if (!err.message.includes(`[LuaScript: ${name}]`)) {
        err.message = `[LuaScript: ${name}] ${err.message}`;
      }
    }
    throw err;
  }
}
