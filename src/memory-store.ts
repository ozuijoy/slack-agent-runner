import type { Env } from './env.ts'
import { githubHeaders, MEMORY_PERMISSIONS, mintInstallationToken, parseRepo } from './github.ts'
import { channelDir, commitMessage, isMemoryPath, MAX_FILES, planMerge, type PushBody, unionLines } from './memory.ts'

/**
 * The memory repo, read and written by the Worker through GitHub's API (the rules are in
 * src/memory.ts). Every call is for ONE channel's folder, and the channel comes from the caller's
 * verified token. The token used here is minted for the memory repo only.
 */

export interface MemoryFile {
  path: string
  sha: string
  content: string
}

/** How many times a push re-reads the branch when another thread pushed first. */
const PUSH_ATTEMPTS = 3

interface Repo {
  api: string
  headers: Record<string, string>
  fetch: typeof fetch
}

async function openRepo(env: Env, fetchImpl: typeof fetch): Promise<Repo> {
  const repo = parseRepo(env.MEMORY_REPO)
  if (!repo) throw new Error('MEMORY_REPO is not set to owner/name')
  const token = await mintInstallationToken(env, fetchImpl, { permissions: { ...MEMORY_PERMISSIONS }, repositories: [repo.name] })
  return { api: `https://api.github.com/repos/${repo.owner}/${repo.name}`, headers: githubHeaders(token), fetch: fetchImpl }
}

async function gh<T>(repo: Repo, path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await repo.fetch(`${repo.api}${path}`, {
    method: init.method ?? 'GET',
    headers: { ...repo.headers, ...(init.body ? { 'content-type': 'application/json' } : {}) },
    ...(init.body ? { body: JSON.stringify(init.body) } : {}),
  })
  if (!res.ok) throw new GitHubError(res.status, `github ${init.method ?? 'GET'} ${path.split('?')[0]}: ${res.status} ${(await res.text()).slice(0, 300)}`)
  return (await res.json()) as T
}

class GitHubError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

/** The default branch's head commit and root tree. An empty repo has neither; setup says to add a README. */
async function head(repo: Repo) {
  const { default_branch: branch } = await gh<{ default_branch: string }>(repo, '')
  let commit: string
  try {
    commit = (await gh<{ object: { sha: string } }>(repo, `/git/ref/heads/${encodeURIComponent(branch)}`)).object.sha
  } catch (err) {
    if (err instanceof GitHubError && (err.status === 404 || err.status === 409)) {
      throw new Error('the memory repo has no commits yet. Add a README to it on GitHub, then try again.')
    }
    throw err
  }
  const tree = (await gh<{ tree: { sha: string } }>(repo, `/git/commits/${commit}`)).tree.sha
  return { branch, commit, tree }
}

/** The channel's folder as path -> sha, paths relative to the folder. Empty when the folder is new. */
async function folder(repo: Repo, rootTree: string, dir: string): Promise<Record<string, string>> {
  const root = await gh<{ tree: Array<{ path: string; type: string; sha: string }> }>(repo, `/git/trees/${rootTree}`)
  const entry = root.tree.find((e) => e.path === dir && e.type === 'tree')
  if (!entry) return {}
  const sub = await gh<{ tree: Array<{ path: string; type: string; sha: string }>; truncated?: boolean }>(
    repo,
    `/git/trees/${entry.sha}?recursive=1`,
  )
  if (sub.truncated) throw new Error(`the memory folder ${dir} is too big for GitHub to list`)
  const files: Record<string, string> = {}
  for (const e of sub.tree) if (e.type === 'blob' && isMemoryPath(e.path)) files[e.path] = e.sha
  return files
}

async function blobText(repo: Repo, sha: string) {
  const blob = await gh<{ content: string; encoding: string }>(repo, `/git/blobs/${sha}`)
  const bytes = Uint8Array.from(atob(blob.content.replace(/\s+/g, '')), (c) => c.charCodeAt(0))
  return new TextDecoder().decode(bytes)
}

/** Every note in the channel's folder, with its sha. */
export async function pullMemory(env: Env, channel: string, fetchImpl: typeof fetch = fetch): Promise<MemoryFile[]> {
  const repo = await openRepo(env, fetchImpl)
  const dir = channelDir(channel)
  const { tree } = await head(repo)
  const shas = Object.entries(await folder(repo, tree, dir)).slice(0, MAX_FILES)
  return Promise.all(shas.map(async ([path, sha]) => ({ path, sha, content: await blobText(repo, sha) })))
}

/**
 * Commits the sandbox's changes to the channel's folder. Merges against the folder as it is NOW
 * (src/memory.ts planMerge) and moves the branch without force, so a thread that pushed in between
 * is never overwritten: the push re-reads and merges again. Returns the commit, or null when
 * there was nothing to change.
 */
export async function pushMemory(
  env: Env,
  who: { channel: string; threadTs: string; turnId: string },
  push: PushBody,
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  const repo = await openRepo(env, fetchImpl)
  const dir = channelDir(who.channel)
  for (let attempt = 1; ; attempt++) {
    const { branch, commit, tree } = await head(repo)
    const remote = await folder(repo, tree, dir)
    const steps = await planMerge(remote, push, who.turnId)
    if (!steps.length) return null

    const entries = await Promise.all(
      steps.map(async (s) => {
        const path = `${dir}/${s.path}`
        if (s.kind === 'delete') return { path, mode: '100644', type: 'blob', sha: null }
        const content = s.kind === 'union' ? unionLines(await blobText(repo, remote[s.path]), s.content) : s.content
        return { path, mode: '100644', type: 'blob', content }
      }),
    )
    const newTree = await gh<{ sha: string }>(repo, '/git/trees', { method: 'POST', body: { base_tree: tree, tree: entries } })
    const created = await gh<{ sha: string }>(repo, '/git/commits', {
      method: 'POST',
      body: { message: commitMessage(dir, who.threadTs, steps), tree: newTree.sha, parents: [commit] },
    })
    try {
      await gh(repo, `/git/refs/heads/${encodeURIComponent(branch)}`, { method: 'PATCH', body: { sha: created.sha, force: false } })
      return created.sha
    } catch (err) {
      // 422: the branch moved (another thread pushed). Merge again against the new head.
      if (!(err instanceof GitHubError && err.status === 422) || attempt >= PUSH_ATTEMPTS) throw err
    }
  }
}
