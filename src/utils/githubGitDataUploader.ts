const GITHUB_API_BASE = 'https://api.github.com';
const GITHUB_API_VERSION = '2022-11-28';

/** Hard per-file cap (20 MB) */
export const MAX_GITHUB_FILE_BYTES = 20 * 1024 * 1024;
/** Safe per-commit payload cap (< 50 MB) */
export const MAX_GITHUB_COMMIT_BYTES = 48 * 1024 * 1024;
/** Max files per single tree/commit batch so GitHub API stays responsive on mobile */
const MAX_FILES_PER_COMMIT = 280;

export interface GitHubRepoConfig {
  repo: string;
  branch: string;
  destFolder: string;
  token: string;
}

export interface ParsedGitHubRepo {
  owner: string;
  repo: string;
  fullName: string;
}

export interface GitHubUploadFile {
  /** Path relative to destFolder (lowercase, forward slashes, no leading slash) */
  path: string;
  bytes: Uint8Array;
}

export interface GitHubFileTransferRecord {
  path: string;
  repoPath: string;
  size: number;
  status: 'uploaded' | 'skipped' | 'failed';
  sha?: string;
  commitSha?: string;
  error?: string;
}

export interface GitHubCommitRecord {
  sha: string;
  message: string;
  fileCount: number;
  bytes: number;
  url: string;
}

export interface GitHubConnectionTestResult {
  ok: boolean;
  repoFullName: string;
  isPrivate: boolean;
  defaultBranch: string;
  branchExists: boolean;
  headSha: string | null;
  message: string;
}

export interface GitHubUploadSession {
  owner: string;
  repo: string;
  branch: string;
  destFolder: string;
  headSha: string;
  treeSha: string;
  existingShas: Map<string, string>;
  /** Internal token holder — never serialize or log */
  _getToken: () => string;
}

export function parseGitHubRepoSlug(raw: string): ParsedGitHubRepo | null {
  let clean = (raw || '').trim();
  clean = clean
    .replace(/^https?:\/\/(?:www\.)?github\.com\//i, '')
    .replace(/\.git$/i, '')
    .replace(/^\/+|\/+$/g, '');
  const parts = clean.split('/').filter(Boolean);
  if (parts.length !== 2) return null;
  const [owner, repo] = parts;
  if (!/^[A-Za-z0-9_.-]{1,100}$/.test(owner) || !/^[A-Za-z0-9_.-]{1,100}$/.test(repo)) {
    return null;
  }
  if (owner === '.' || owner === '..' || repo === '.' || repo === '..') return null;
  return { owner, repo, fullName: `${owner}/${repo}` };
}

export function normalizeGitHubBranch(raw: string): string {
  const clean = (raw || '').trim().replace(/^refs\/heads\//i, '');
  if (!clean || /\.\.|[\s~^:?*[\]\\]/.test(clean) || clean.startsWith('/') || clean.endsWith('/')) {
    return 'main';
  }
  return clean;
}

export function normalizeGitHubDestFolder(raw: string): string {
  const parts = (raw || '')
    .replace(/\\/g, '/')
    .split('/')
    .map((seg) => seg.trim())
    .filter((seg) => seg.length > 0 && seg !== '.' && seg !== '..');
  return parts.join('/');
}

export function joinRepoPath(destFolder: string, relPath: string): string {
  const cleanRel = relPath.replace(/\\/g, '/').replace(/^\/+/, '');
  const cleanFolder = normalizeGitHubDestFolder(destFolder);
  return cleanFolder ? `${cleanFolder}/${cleanRel}` : cleanRel;
}

function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, '0');
  }
  return out;
}

/**
 * Pure-JS SHA-1 fallback for environments without crypto.subtle (e.g. non-HTTPS LAN Chrome).
 */
function sha1Fallback(data: Uint8Array): Uint8Array {
  const ml = data.length * 8;
  const paddedLen = Math.ceil((data.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLen);
  padded.set(data);
  padded[data.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLen - 8, Math.floor(ml / 0x100000000), false);
  view.setUint32(paddedLen - 4, ml >>> 0, false);

  let h0 = 0x67452301;
  let h1 = 0xefcdab89;
  let h2 = 0x98badcfe;
  let h3 = 0x10325476;
  let h4 = 0xc3d2e1f0;
  const w = new Uint32Array(80);

  for (let offset = 0; offset < paddedLen; offset += 64) {
    for (let i = 0; i < 16; i++) {
      w[i] = view.getUint32(offset + i * 4, false);
    }
    for (let i = 16; i < 80; i++) {
      const n = w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16];
      w[i] = ((n << 1) | (n >>> 31)) >>> 0;
    }

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;

    for (let i = 0; i < 80; i++) {
      let f = 0;
      let k = 0;
      if (i < 20) {
        f = (b & c) | (~b & d);
        k = 0x5a827999;
      } else if (i < 40) {
        f = b ^ c ^ d;
        k = 0x6ed9eba1;
      } else if (i < 60) {
        f = (b & c) | (b & d) | (c & d);
        k = 0x8f1bbcdc;
      } else {
        f = b ^ c ^ d;
        k = 0xca62c1d6;
      }
      const temp = ((((a << 5) | (a >>> 27)) >>> 0) + f + e + k + w[i]) >>> 0;
      e = d;
      d = c;
      c = ((b << 30) | (b >>> 2)) >>> 0;
      b = a;
      a = temp;
    }

    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
  }

  const digest = new Uint8Array(20);
  const dv = new DataView(digest.buffer);
  dv.setUint32(0, h0, false);
  dv.setUint32(4, h1, false);
  dv.setUint32(8, h2, false);
  dv.setUint32(12, h3, false);
  dv.setUint32(16, h4, false);
  return digest;
}

/**
 * Computes Git's exact blob SHA-1: sha1("blob <byteLength>\0" + bytes).
 */
export async function computeGitBlobSha1(bytes: Uint8Array): Promise<string> {
  const header = new TextEncoder().encode(`blob ${bytes.byteLength}\0`);
  const payload = new Uint8Array(header.byteLength + bytes.byteLength);
  payload.set(header, 0);
  payload.set(bytes, header.byteLength);

  if (typeof crypto !== 'undefined' && crypto.subtle && typeof crypto.subtle.digest === 'function') {
    try {
      const digest = await crypto.subtle.digest('SHA-1', payload);
      return bytesToHex(new Uint8Array(digest));
    } catch {
      // Fallback on insecure contexts
    }
  }
  return bytesToHex(sha1Fallback(payload));
}

function bytesToBase64(bytes: Uint8Array): string {
  // 30720 is divisible by 3 so each chunk produces unpadded base64 cleanly concatenatable
  const CHUNK3 = 30720;
  const aligned: string[] = [];
  for (let i = 0; i < bytes.length; i += CHUNK3) {
    const slice = bytes.subarray(i, Math.min(i + CHUNK3, bytes.length));
    let bin = '';
    for (let j = 0; j < slice.length; j++) {
      bin += String.fromCharCode(slice[j]);
    }
    aligned.push(btoa(bin));
  }
  return aligned.join('');
}

function base64ToUtf8(b64: string): string {
  const clean = b64.replace(/\s+/g, '');
  const bin = atob(clean);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    bytes[i] = bin.charCodeAt(i);
  }
  return new TextDecoder().decode(bytes);
}

function waitMs(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(new DOMException('Envio cancelado.', 'AbortError'));
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException('Envio cancelado.', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

class GitHubHttpError extends Error {
  status: number;
  retryAfterSec?: number;
  constructor(status: number, message: string, retryAfterSec?: number) {
    super(message);
    this.name = 'GitHubHttpError';
    this.status = status;
    this.retryAfterSec = retryAfterSec;
  }
}

async function githubFetchJson<T>(
  endpointPath: string,
  token: string,
  init?: { method?: string; body?: unknown; signal?: AbortSignal },
  maxRetries = 4
): Promise<T> {
  const url = `${GITHUB_API_BASE}${endpointPath}`;
  const method = init?.method || 'GET';
  const bodyStr = init?.body !== undefined ? JSON.stringify(init.body) : undefined;

  let lastErr: unknown = null;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    if (init?.signal?.aborted) {
      throw new DOMException('Envio cancelado.', 'AbortError');
    }
    try {
      const resp = await fetch(url, {
        method,
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${token}`,
          'X-GitHub-Api-Version': GITHUB_API_VERSION,
          ...(bodyStr !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: bodyStr,
        signal: init?.signal,
      });

      if (resp.ok) {
        if (resp.status === 204) return undefined as T;
        return (await resp.json()) as T;
      }

      let apiMsg = `HTTP ${resp.status}`;
      try {
        const errJson = (await resp.json()) as { message?: string };
        if (errJson?.message) apiMsg = `${errJson.message} (HTTP ${resp.status})`;
      } catch {
        // ignore JSON parse errors
      }

      const retryAfterRaw = resp.headers.get('retry-after');
      const retryAfterSec = retryAfterRaw ? Number(retryAfterRaw) : undefined;
      const err = new GitHubHttpError(
        resp.status,
        apiMsg,
        Number.isFinite(retryAfterSec) ? retryAfterSec : undefined
      );

      // Auth / permission / not-found / validation errors should not retry
      if (resp.status === 401 || resp.status === 404 || resp.status === 422) {
        throw err;
      }
      if (resp.status === 403 && !apiMsg.toLowerCase().includes('rate limit')) {
        throw err;
      }

      lastErr = err;
      if (attempt < maxRetries - 1) {
        const delayMs =
          err.retryAfterSec && err.retryAfterSec > 0
            ? Math.min(30_000, err.retryAfterSec * 1000)
            : Math.min(15_000, 1200 * Math.pow(2, attempt));
        await waitMs(delayMs, init?.signal);
        continue;
      }
      throw err;
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') throw err;
      if (
        err instanceof GitHubHttpError &&
        (err.status === 401 || err.status === 404 || err.status === 422)
      ) {
        throw err;
      }
      lastErr = err;
      if (attempt < maxRetries - 1) {
        const delayMs = Math.min(12_000, 1000 * Math.pow(2, attempt));
        await waitMs(delayMs, init?.signal);
        continue;
      }
      throw lastErr;
    }
  }

  throw lastErr instanceof Error ? lastErr : new Error('Falha de rede na API do GitHub.');
}

export async function testGitHubConnection(
  config: GitHubRepoConfig,
  signal?: AbortSignal
): Promise<GitHubConnectionTestResult> {
  const parsed = parseGitHubRepoSlug(config.repo);
  if (!parsed) {
    return {
      ok: false,
      repoFullName: config.repo,
      isPrivate: false,
      defaultBranch: 'main',
      branchExists: false,
      headSha: null,
      message: 'Informe o repositório no formato usuario/repositorio.',
    };
  }
  const token = config.token.trim();
  if (!token) {
    return {
      ok: false,
      repoFullName: parsed.fullName,
      isPrivate: false,
      defaultBranch: 'main',
      branchExists: false,
      headSha: null,
      message: 'Informe um token fine-grained com permissão Contents: Read and write.',
    };
  }

  const branch = normalizeGitHubBranch(config.branch);

  try {
    const repoInfo = await githubFetchJson<{
      full_name: string;
      private: boolean;
      default_branch: string;
      permissions?: { push?: boolean };
    }>(`/repos/${parsed.owner}/${parsed.repo}`, token, { signal }, 2);

    let headSha: string | null = null;
    let branchExists = false;
    try {
      const refData = await githubFetchJson<{ object?: { sha?: string } }>(
        `/repos/${parsed.owner}/${parsed.repo}/git/ref/heads/${encodeURIComponent(branch)}`,
        token,
        { signal },
        2
      );
      headSha = refData?.object?.sha || null;
      branchExists = Boolean(headSha);
    } catch (err) {
      if (!(err instanceof GitHubHttpError && (err.status === 404 || err.status === 409))) {
        throw err;
      }
    }

    const canPush = repoInfo.permissions?.push !== false;
    return {
      ok: canPush,
      repoFullName: repoInfo.full_name,
      isPrivate: Boolean(repoInfo.private),
      defaultBranch: repoInfo.default_branch || 'main',
      branchExists,
      headSha,
      message: !canPush
        ? 'Token sem permissão de escrita (Contents: Read and write) neste repositório.'
        : branchExists
        ? `Conectado a ${repoInfo.full_name} (${repoInfo.private ? 'privado' : 'público'}) · branch "${branch}" pronta.`
        : `Conectado a ${repoInfo.full_name}. Branch "${branch}" ainda não existe (será criada a partir de "${repoInfo.default_branch || 'main'}" ou inicializada).`,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Falha ao conectar ao GitHub.';
    return {
      ok: false,
      repoFullName: parsed.fullName,
      isPrivate: false,
      defaultBranch: 'main',
      branchExists: false,
      headSha: null,
      message: msg.includes('401')
        ? 'Token inválido ou expirado (HTTP 401).'
        : msg.includes('404')
        ? 'Repositório não encontrado ou token sem acesso a ele (HTTP 404).'
        : msg,
    };
  }
}

export async function createGitHubUploadSession(
  config: GitHubRepoConfig,
  signal?: AbortSignal
): Promise<GitHubUploadSession> {
  const parsed = parseGitHubRepoSlug(config.repo);
  if (!parsed) {
    throw new Error('Repositório inválido. Use o formato usuario/repositorio.');
  }
  const token = config.token.trim();
  if (!token) {
    throw new Error('Token do GitHub não informado.');
  }
  const branch = normalizeGitHubBranch(config.branch);
  const destFolder = normalizeGitHubDestFolder(config.destFolder);

  const repoInfo = await githubFetchJson<{ default_branch?: string }>(
    `/repos/${parsed.owner}/${parsed.repo}`,
    token,
    { signal }
  );
  const defaultBranch = repoInfo.default_branch || 'main';

  let headSha = '';
  try {
    const refData = await githubFetchJson<{ object: { sha: string } }>(
      `/repos/${parsed.owner}/${parsed.repo}/git/ref/heads/${encodeURIComponent(branch)}`,
      token,
      { signal }
    );
    headSha = refData.object.sha;
  } catch (err) {
    if (err instanceof GitHubHttpError && (err.status === 404 || err.status === 409)) {
      // Try branching off default_branch if it exists; otherwise bootstrap empty repo via Contents API
      let baseSha = '';
      if (branch !== defaultBranch) {
        try {
          const defRef = await githubFetchJson<{ object: { sha: string } }>(
            `/repos/${parsed.owner}/${parsed.repo}/git/ref/heads/${encodeURIComponent(defaultBranch)}`,
            token,
            { signal }
          );
          baseSha = defRef.object.sha;
        } catch {
          // empty repo
        }
      }

      if (baseSha) {
        const createdRef = await githubFetchJson<{ object: { sha: string } }>(
          `/repos/${parsed.owner}/${parsed.repo}/git/refs`,
          token,
          {
            method: 'POST',
            body: { ref: `refs/heads/${branch}`, sha: baseSha },
            signal,
          }
        );
        headSha = createdRef.object.sha;
      } else {
        // Bootstrap completely empty repository with a tiny README
        const initPath = destFolder ? `${destFolder}/.gitkeep` : '.gitkeep';
        const initResp = await githubFetchJson<{ commit: { sha: string } }>(
          `/repos/${parsed.owner}/${parsed.repo}/contents/${initPath.split('/').map(encodeURIComponent).join('/')}`,
          token,
          {
            method: 'PUT',
            body: {
              message: 'chore: initialize shinobi game assets folder',
              content: '',
              branch,
            },
            signal,
          }
        );
        headSha = initResp.commit.sha;
      }
    } else {
      throw err;
    }
  }

  const commitData = await githubFetchJson<{ tree: { sha: string } }>(
    `/repos/${parsed.owner}/${parsed.repo}/git/commits/${headSha}`,
    token,
    { signal }
  );
  const treeSha = commitData.tree.sha;

  // Read existing recursive tree to skip unchanged files by exact Git blob SHA-1
  const existingShas = new Map<string, string>();
  try {
    const treeData = await githubFetchJson<{
      tree?: Array<{ path?: string; type?: string; sha?: string }>;
    }>(
      `/repos/${parsed.owner}/${parsed.repo}/git/trees/${treeSha}?recursive=1`,
      token,
      { signal }
    );
    for (const entry of treeData.tree || []) {
      if (entry.type === 'blob' && entry.path && entry.sha) {
        existingShas.set(entry.path, entry.sha);
      }
    }
  } catch {
    // Non-fatal: if tree listing fails on huge repos, we still upload safely
  }

  return {
    owner: parsed.owner,
    repo: parsed.repo,
    branch,
    destFolder,
    headSha,
    treeSha,
    existingShas,
    _getToken: () => token,
  };
}

/**
 * Reads an existing JSON file from the repository (e.g. `index.json`) using its blob SHA.
 */
export async function fetchExistingRepoJson<T>(
  session: GitHubUploadSession,
  relPath: string,
  signal?: AbortSignal
): Promise<T | null> {
  const repoPath = joinRepoPath(session.destFolder, relPath);
  const sha = session.existingShas.get(repoPath);
  if (!sha) return null;
  try {
    const blob = await githubFetchJson<{ content?: string; encoding?: string }>(
      `/repos/${session.owner}/${session.repo}/git/blobs/${sha}`,
      session._getToken(),
      { signal },
      2
    );
    if (!blob?.content) return null;
    const text = blob.encoding === 'base64' ? base64ToUtf8(blob.content) : blob.content;
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

export interface UploadBatchCallbacks {
  onStatus?: (message: string) => void;
  onFileDone?: (record: GitHubFileTransferRecord) => void;
  onCommitCreated?: (commit: GitHubCommitRecord) => void;
}

/**
 * Uploads a set of files via GitHub Git Data API (blobs -> tree -> commit -> update ref):
 * - Computes local Git SHA-1 and skips files already identical in the repo.
 * - Splits uploads into commits <= 48 MB (safely below 50 MB).
 * - Automatically retries transient network / rate-limit errors.
 */
export async function uploadFilesBatchToGitHub(
  session: GitHubUploadSession,
  files: GitHubUploadFile[],
  commitMessageBase: string,
  callbacks?: UploadBatchCallbacks,
  signal?: AbortSignal
): Promise<{
  records: GitHubFileTransferRecord[];
  commits: GitHubCommitRecord[];
}> {
  const token = session._getToken();
  const records: GitHubFileTransferRecord[] = [];
  const commits: GitHubCommitRecord[] = [];

  interface PendingFile {
    path: string;
    repoPath: string;
    bytes: Uint8Array;
    localSha: string;
  }

  const toUpload: PendingFile[] = [];

  for (const file of files) {
    if (signal?.aborted) {
      throw new DOMException('Envio cancelado.', 'AbortError');
    }
    const repoPath = joinRepoPath(session.destFolder, file.path);
    if (file.bytes.byteLength > MAX_GITHUB_FILE_BYTES) {
      const rec: GitHubFileTransferRecord = {
        path: file.path,
        repoPath,
        size: file.bytes.byteLength,
        status: 'failed',
        error: 'Arquivo excede o limite de 20 MB.',
      };
      records.push(rec);
      callbacks?.onFileDone?.(rec);
      continue;
    }

    const localSha = await computeGitBlobSha1(file.bytes);
    const existingSha = session.existingShas.get(repoPath);
    if (existingSha && existingSha === localSha) {
      const rec: GitHubFileTransferRecord = {
        path: file.path,
        repoPath,
        size: file.bytes.byteLength,
        status: 'skipped',
        sha: existingSha,
      };
      records.push(rec);
      callbacks?.onFileDone?.(rec);
      continue;
    }

    toUpload.push({
      path: file.path,
      repoPath,
      bytes: file.bytes,
      localSha,
    });
  }

  if (toUpload.length === 0) {
    return { records, commits };
  }

  // Group into commits <= 48 MB and <= MAX_FILES_PER_COMMIT
  const commitBatches: PendingFile[][] = [];
  let currentBatch: PendingFile[] = [];
  let currentBytes = 0;

  for (const item of toUpload) {
    if (
      currentBatch.length > 0 &&
      (currentBytes + item.bytes.byteLength > MAX_GITHUB_COMMIT_BYTES ||
        currentBatch.length >= MAX_FILES_PER_COMMIT)
    ) {
      commitBatches.push(currentBatch);
      currentBatch = [];
      currentBytes = 0;
    }
    currentBatch.push(item);
    currentBytes += item.bytes.byteLength;
  }
  if (currentBatch.length > 0) {
    commitBatches.push(currentBatch);
  }

  for (let bIdx = 0; bIdx < commitBatches.length; bIdx++) {
    if (signal?.aborted) {
      throw new DOMException('Envio cancelado.', 'AbortError');
    }
    const batch = commitBatches[bIdx];
    const batchTotalBytes = batch.reduce((s, f) => s + f.bytes.byteLength, 0);
    const treeEntries: Array<{
      path: string;
      mode: '100644';
      type: 'blob';
      sha: string;
    }> = [];
    const uploadedInBatch: Array<{ item: PendingFile; sha: string }> = [];

    // Upload blobs with controlled concurrency (3 at a time)
    const CONCURRENCY = 3;
    let cursor = 0;
    let doneCount = 0;

    const worker = async () => {
      while (true) {
        const idx = cursor++;
        if (idx >= batch.length) return;
        if (signal?.aborted) {
          throw new DOMException('Envio cancelado.', 'AbortError');
        }
        const item = batch[idx];
        callbacks?.onStatus?.(
          `Enviando blob (${doneCount + 1}/${batch.length}) · ${item.path}`
        );

        const blobResp = await githubFetchJson<{ sha: string }>(
          `/repos/${session.owner}/${session.repo}/git/blobs`,
          token,
          {
            method: 'POST',
            body: {
              content: bytesToBase64(item.bytes),
              encoding: 'base64',
            },
            signal,
          },
          4
        );

        treeEntries.push({
          path: item.repoPath,
          mode: '100644',
          type: 'blob',
          sha: blobResp.sha,
        });
        uploadedInBatch.push({ item, sha: blobResp.sha });
        doneCount++;
      }
    };

    const workers: Promise<void>[] = [];
    for (let w = 0; w < Math.min(CONCURRENCY, batch.length); w++) {
      workers.push(worker());
    }
    await Promise.all(workers);

    const partSuffix =
      commitBatches.length > 1 ? ` (parte ${bIdx + 1}/${commitBatches.length})` : '';
    const commitMsg = `${commitMessageBase}${partSuffix}`;

    callbacks?.onStatus?.(`Criando árvore e commit no GitHub${partSuffix}...`);

    const newTree = await githubFetchJson<{ sha: string }>(
      `/repos/${session.owner}/${session.repo}/git/trees`,
      token,
      {
        method: 'POST',
        body: {
          base_tree: session.treeSha,
          tree: treeEntries,
        },
        signal,
      },
      4
    );

    const newCommit = await githubFetchJson<{ sha: string; html_url?: string }>(
      `/repos/${session.owner}/${session.repo}/git/commits`,
      token,
      {
        method: 'POST',
        body: {
          message: commitMsg,
          tree: newTree.sha,
          parents: [session.headSha],
        },
        signal,
      },
      4
    );

    await githubFetchJson<unknown>(
      `/repos/${session.owner}/${session.repo}/git/refs/heads/${encodeURIComponent(session.branch)}`,
      token,
      {
        method: 'PATCH',
        body: {
          sha: newCommit.sha,
          force: false,
        },
        signal,
      },
      4
    );

    session.headSha = newCommit.sha;
    session.treeSha = newTree.sha;

    for (const { item, sha } of uploadedInBatch) {
      session.existingShas.set(item.repoPath, sha);
      const rec: GitHubFileTransferRecord = {
        path: item.path,
        repoPath: item.repoPath,
        size: item.bytes.byteLength,
        status: 'uploaded',
        sha,
        commitSha: newCommit.sha,
      };
      records.push(rec);
      callbacks?.onFileDone?.(rec);
    }

    const commitRec: GitHubCommitRecord = {
      sha: newCommit.sha,
      message: commitMsg,
      fileCount: uploadedInBatch.length,
      bytes: batchTotalBytes,
      url:
        newCommit.html_url ||
        `https://github.com/${session.owner}/${session.repo}/commit/${newCommit.sha}`,
    };
    commits.push(commitRec);
    callbacks?.onCommitCreated?.(commitRec);
  }

  return { records, commits };
}
