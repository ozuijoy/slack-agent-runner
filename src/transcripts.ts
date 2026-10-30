import type { CallbackClaims } from './callback-token.ts'

/**
 * The rules for the R2 transcript backup. After every turn the sandbox uploads the thread's Claude
 * transcript (gzipped JSONL) to POST /sandbox/transcript with its one-turn token. Each turn writes
 * a NEW object, and the door refuses a second upload for the same turn (src/index.ts), so nothing is
 * overwritten, and there is no delete: backups are kept forever.
 *
 * The sandbox is untrusted (Claude runs there on text anyone can write), so the key is built ONLY
 * from the token's signed claims, never from the request. A sandbox cannot name another thread's
 * object.
 */

/** Far above a real transcript, and under the Worker's 100 MB request body limit. */
export const MAX_TRANSCRIPT_BYTES = 50 * 1024 * 1024

export function transcriptPrefix(channel: string, threadTs: string) {
  return `transcripts/${channel}/${threadTs}/`
}

/** `transcripts/<channel>/<threadTs>/<lastTs>-<turnId>.jsonl.gz`. The Slack ts sorts the turns. */
export function transcriptKey(claims: Pick<CallbackClaims, 'channel' | 'threadTs' | 'turnId' | 'lastTs'>) {
  return `${transcriptPrefix(claims.channel, claims.threadTs)}${claims.lastTs}-${claims.turnId}.jsonl.gz`
}

/** Checks the declared size before the body is read. Null means fine, else the refusal. */
export function checkTranscriptSize(contentLength: string | null): { status: number; error: string } | null {
  const n = Number(contentLength)
  if (contentLength === null || !Number.isInteger(n) || n < 0) return { status: 411, error: 'content-length required' }
  if (n === 0) return { status: 400, error: 'empty transcript' }
  if (n > MAX_TRANSCRIPT_BYTES) return { status: 413, error: `transcript over ${MAX_TRANSCRIPT_BYTES} bytes` }
  return null
}
