import type { Env } from './env.ts'

/**
 * The Durable Object for one Slack thread, named `channel:threadTs` (src/thread-state.ts). Kept
 * apart from the class so code that only calls a thread, and its tests, need not load the
 * Cloudflare runtime.
 */
export function threadStub(env: Pick<Env, 'THREADS'>, channel: string, threadTs: string) {
  return env.THREADS.get(env.THREADS.idFromName(`${channel}:${threadTs}`))
}
