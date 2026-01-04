import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRedis } from '../helpers/redis';
import type Redis from 'ioredis';

const LUA_DIR = 'src/lua';

describe('Lua Scripts Validation', () => {
  let redis: Redis;

  beforeAll(async () => {
    redis = createRedis();
  });

  afterAll(async () => {
    await redis.quit();
  });

  // Get all Lua files
  const luaFiles = readdirSync(LUA_DIR)
    .filter((file) => file.endsWith('.lua'))
    .sort();

  it.each(luaFiles)('should have valid syntax: %s', async (file) => {
    const filePath = join(LUA_DIR, file);
    const content = readFileSync(filePath, 'utf8');

    // Use Redis SCRIPT LOAD to validate the script
    // This will compile the script and return an error if there are syntax issues
    await expect(
      (redis as any).script('LOAD', content)
    ).resolves.toBeDefined();
  });

  it('should have at least one Lua script', () => {
    expect(luaFiles.length).toBeGreaterThan(0);
  });
});
