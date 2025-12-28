import type Redis from 'ioredis'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

/**
 * Redis Functions-based Lua script loader
 *
 * Replaces the evalsha approach with Redis Functions (FCALL).
 * Redis Functions are server-side persistent and more efficient than script loading.
 *
 * Function name mapping:
 * - Dashes in ScriptName (e.g., "enqueue-batch") are converted to underscores (e.g., "enqueue_batch")
 * - All functions are registered in the "queue_lib" library
 */

// Track which Redis clients have already loaded the Functions
const loadedClients = new WeakMap<Redis, boolean>()

// Track loading promises to prevent concurrent load attempts
const loadingPromises = new WeakMap<Redis, Promise<void>>()

// Track the hash of loaded code to detect changes (for development)
const loadedCodeHashes = new WeakMap<Redis, string>()

export type ScriptName =
  // Core operations
  | 'enqueue'
  | 'enqueue-batch'
  | 'enqueue-flow'
  | 'reserve'
  | 'reserve-batch'
  | 'reserve-atomic'
  | 'complete'
  | 'complete-and-reserve-next-with-metadata'
  | 'complete-with-metadata'

  // Job management
  | 'retry'
  | 'heartbeat'
  | 'dead-letter'
  | 'remove'

  // Cleanup and maintenance
  | 'cleanup'
  | 'clean-status'
  | 'check-stalled'
  | 'cleanup-poisoned-group'

  // Delayed job promotion
  | 'promote-delayed-jobs'
  | 'promote-delayed-one'
  | 'promote-staged'

  // Job modification
  | 'change-delay'
  | 'record-job-result'

  // Query operations
  | 'get-active-count'
  | 'get-waiting-count'
  | 'get-delayed-count'
  | 'get-active-jobs'
  | 'get-waiting-jobs'
  | 'get-delayed-jobs'
  | 'get-unique-groups'
  | 'get-unique-groups-count'

  // Status and validation
  | 'is-empty'
  | 'validate-limited-set'

const LIBRARY_NAME = 'queue_lib'

/**
 * Convert ScriptName with dashes to Redis Function name with underscores
 * e.g., "enqueue-batch" -> "enqueue_batch"
 */
function toFunctionName(scriptName: ScriptName): string {
  return scriptName.replace(/-/g, '_')
}

/**
 * Execute a Redis Function using FCALL
 * Automatically loads Functions on first call if not already loaded
 *
 * @param client Redis client instance
 * @param functionName Script name (with dashes, e.g., "enqueue-batch")
 * @param keys Array of Redis keys to pass as KEYS
 * @param argv Array of arguments to pass as ARGV
 * @returns Result from the Redis Function
 *
 * Note: FCALL syntax is:
 *   FCALL function_name numkeys key [key ...] arg [arg ...]
 */
export async function callFunction<T = any>(
  client: Redis,
  functionName: ScriptName,
  keys: string[],
  argv: string[]
): Promise<T> {
  // Ensure Functions are loaded before calling
  await ensureFunctionsLoaded(client)

  const luaFunctionName = toFunctionName(functionName)

  // FCALL is available in ioredis as a method or via call()
  // Construct the full command: FCALL <function_name> <numkeys> [keys...] [args...]
  const numKeys = keys.length
  const command = ['FCALL', luaFunctionName, numKeys.toString(), ...keys, ...argv]

  return (client as any).call(...command) as Promise<T>
}

/**
 * Legacy wrapper: maintains same interface as old evalScript for backward compatibility during migration
 *
 * This function translates the old evalScript(client, name, argv, numKeys) API to the new
 * callFunction(client, name, keys, argv) API.
 *
 * Old API: evalScript(client, 'enqueue', [ns, ...otherArgs], 1)
 *   - argv: all arguments (first numKeys elements are keys, rest are regular args)
 *   - numKeys: number of keys in argv
 *
 * New API: callFunction(client, 'enqueue', [ns], [...otherArgs])
 *   - keys: array of Redis keys
 *   - argv: array of regular arguments (not including keys)
 */
export async function evalScript<T = any>(
  client: Redis,
  name: ScriptName,
  argv: Array<string>,
  numKeys: number,
): Promise<T> {
  // Split argv into keys and args based on numKeys
  const keys = argv.slice(0, numKeys)
  const args = argv.slice(numKeys)

  return callFunction<T>(client, name, keys, args)
}


/**
 * Load queue_lib Functions from the Lua file
 * This reads the queue_lib.lua file and loads it into Redis using FUNCTION LOAD
 *
 * Behavior:
 * - Production: Caches per Redis client instance (loads once per connection)
 * - Development: Detects code changes via hash and reloads if needed
 *
 * If the library already exists and code hasn't changed, it reuses the existing version.
 * If code changes, automatically deletes and reloads with the new version.
 * Prevents concurrent load attempts on the same client instance.
 */
export async function ensureFunctionsLoaded(client: Redis): Promise<void> {
  // Read the current code
  const luaFilePath = join(__dirname, 'queue_lib.lua')
  const luaCode = readFileSync(luaFilePath, 'utf-8')
  const currentHash = createHash('sha256').update(luaCode).digest('hex')

  // Check if we've already loaded this exact version for this client
  const cachedHash = loadedCodeHashes.get(client)
  if (cachedHash === currentHash && loadedClients.has(client)) {
    return
  }

  // Check if we're already in the process of loading
  if (loadingPromises.has(client)) {
    return await loadingPromises.get(client)
  }

  // Create the loading promise to track concurrent attempts
  const loadPromise = performLoad(client, luaCode)
  loadingPromises.set(client, loadPromise)

  try {
    await loadPromise
    loadedClients.set(client, true)
    loadedCodeHashes.set(client, currentHash)
  } finally {
    // Clear the loading promise after completion
    loadingPromises.delete(client)
  }
}

/**
 * Performs the actual loading of the queue_lib Functions
 */
async function performLoad(client: Redis, luaCode: string): Promise<void> {
  try {
    // Try to delete the existing library first (if it exists)
    try {
      console.log('删除旧库')
      await (client as any).call('FUNCTION', 'DELETE', 'queue_lib')
      console.log('删除旧库成功')
    } catch (deleteErr: any) {
      const deleteErrMsg = deleteErr?.message || ''
      // Ignore "Library not found" errors - it's OK if the library doesn't exist yet
      if (!deleteErrMsg.includes('no such library')) {
        console.warn('删除旧库时出现警告:', deleteErrMsg)
      }
    }

    // Load the Functions library using FUNCTION LOAD
    console.log('加载新库')
    await (client as any).call('FUNCTION', 'LOAD', luaCode)
    console.log('加载新库成功')
  } catch (err: any) {
    const errMsg = err?.message || ''
    if (errMsg.includes('FUNCTION')) {
      throw new Error(
        `Failed to load queue_lib Functions. Redis version must be 7.0+.\n` +
        `Error: ${errMsg}`
      )
    }
    throw err
  }
}
