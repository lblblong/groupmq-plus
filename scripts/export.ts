import fs from "node:fs/promises";
import path from "node:path";
import Redis from "ioredis";

type ExportEntry = {
  key: string;
  type: string;
  ttlSeconds: number | null;
  value: unknown;
};

const DEFAULT_SCAN_COUNT = Number(process.env.EXPORT_SCAN_COUNT ?? 1000);

function showUsage() {
  console.log(`Usage: tsx ./scripts/export.ts [options] <pattern>...

Options:
  --redis <url>     Redis connection string (env REDIS_URL / REDIS_URI or redis://localhost:6379)
  --out <path>      Write JSON output to a file instead of stdout
  --batch <number>  SCAN COUNT value (default ${DEFAULT_SCAN_COUNT})
  --help            Show this help message
`);
}

function parseArgs(args: string[]) {
  const patterns: string[] = [];
  // let redisUrl = process.env.REDIS_URL ?? process.env.REDIS_URI ?? "redis://localhost:6379";
  let redisUrl = "redis://default@192.168.0.8:6380/0";
  let outFile: string | undefined;
  let scanCount = DEFAULT_SCAN_COUNT;

  for (let idx = 0; idx < args.length; idx++) {
    const curr = args[idx];
    if (!curr) continue;
    if (curr === "--help") {
      showUsage();
      process.exit(0);
    }
    if (curr === "--redis") {
      idx += 1;
      redisUrl = args[idx] ?? redisUrl;
      continue;
    }
    if (curr === "--out") {
      idx += 1;
      outFile = args[idx];
      continue;
    }
    if (curr === "--batch") {
      idx += 1;
      scanCount = Number(args[idx]) || scanCount;
      continue;
    }
    if (curr.startsWith("--")) {
      console.warn(`Unknown option ${curr}`);
      showUsage();
      process.exit(1);
    }
    patterns.push(curr);
  }

  if (!patterns.length) {
    console.error("Please provide at least one key pattern.");
    showUsage();
    process.exit(1);
  }

  return { patterns, redisUrl, outFile, scanCount };
}

async function* scanKeys(client: Redis, pattern: string, count: number) {
  let cursor = "0";
  do {
    const [nextCursor, keys] = await client.scan(cursor, "MATCH", pattern, "COUNT", count);
    cursor = nextCursor;
    yield* keys;
  } while (cursor !== "0");
}

async function exportKey(client: Redis, key: string): Promise<ExportEntry> {
  const type = await client.type(key);
  const ttlSecondsRaw = await client.ttl(key);
  const ttlSeconds = ttlSecondsRaw >= 0 ? ttlSecondsRaw : null;

  try {
    let value: unknown;
    switch (type) {
      case "string":
        value = await client.get(key);
        break;
      case "list":
        value = await client.lrange(key, 0, -1);
        break;
      case "hash":
        value = await client.hgetall(key);
        break;
      case "set":
        value = await client.smembers(key);
        break;
      case "zset": {
        const raw = await client.zrange(key, 0, -1, "WITHSCORES");
        const rows: Array<{ member: string; score: number }> = [];
        for (let idx = 0; idx < raw.length; idx += 2) {
          rows.push({ member: raw[idx], score: Number(raw[idx + 1]) });
        }
        value = rows;
        break;
      }
      case "stream":
        value = await readStreamEntries(client, key);
        break;
      default: {
        const dump = await client.dump(key);
        value = dump ? dump.toString("base64") : null;
        break;
      }
    }
    return { key, type, ttlSeconds, value };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { key, type, ttlSeconds, value: { error: message } };
  }
}

async function readStreamEntries(client: Redis, key: string) {
  const entries: Array<{ id: string; fields: Record<string, string> }> = [];
  const batchSize = 1000;
  let cursor: string | undefined = undefined;

  while (true) {
    const start = cursor ?? "-";
    const batch = await client.xrange(key, start, "+", "COUNT", batchSize);
    if (!batch.length) break;
    for (const [id, fields] of batch) {
      entries.push({ id, fields: tupleToObject(fields) });
    }
    const lastId = batch[batch.length - 1][0];
    cursor = `(${lastId}`;
    if (batch.length < batchSize) break;
  }

  return entries;
}

function tupleToObject(pair: string[]) {
  const result: Record<string, string> = {};
  for (let idx = 0; idx < pair.length; idx += 2) {
    result[pair[idx]] = pair[idx + 1];
  }
  return result;
}

async function main() {
  const { patterns, redisUrl, outFile, scanCount } = parseArgs(process.argv.slice(2));
  const client = new Redis(redisUrl, { enableAutoPipelining: true, maxRetriesPerRequest: 2 });
  const seen = new Set<string>();
  const payload: ExportEntry[] = [];

  try {
    for (const pattern of patterns) {
      for await (const key of scanKeys(client, pattern, scanCount)) {
        if (seen.has(key)) continue;
        seen.add(key);
        payload.push(await exportKey(client, key));
      }
    }

    const serialized = JSON.stringify(payload, null, 2);

    if (outFile) {
      await fs.mkdir(path.dirname(outFile), { recursive: true });
      await fs.writeFile(outFile, `${serialized}\n`, "utf8");
      console.info(`Wrote ${payload.length} key(s) to ${outFile}`);
    } else {
      console.log(serialized);
    }
  } catch (error) {
    console.error("Export failed:", error);
    process.exitCode = 1;
  } finally {
    await client.quit().catch(() => undefined);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
