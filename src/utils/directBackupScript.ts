import { buildCorsRelayUrl } from './remoteClient';

export const CLOUDFLARE_WORKER_PROXY_CODE = `// Proxy CORS gratuito para Shinobi Sprite Studio (Cloudflare Workers)
// Restrito exclusivamente a naruto.jotagame.com para sua segurança.
export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
          'Access-Control-Allow-Headers': '*',
          'Access-Control-Max-Age': '86400',
        },
      });
    }

    const reqUrl = new URL(request.url);
    const target = reqUrl.searchParams.get('url');
    if (!target) {
      return new Response('Uso: ?url=https://naruto.jotagame.com/...', {
        status: 400,
        headers: { 'Access-Control-Allow-Origin': '*' },
      });
    }

    let parsed;
    try {
      parsed = new URL(target);
    } catch {
      return new Response('URL invalida', {
        status: 400,
        headers: { 'Access-Control-Allow-Origin': '*' },
      });
    }

    if (parsed.hostname !== 'naruto.jotagame.com') {
      return new Response('Dominio nao permitido', {
        status: 403,
        headers: { 'Access-Control-Allow-Origin': '*' },
      });
    }

    const upstream = await fetch(parsed.toString(), {
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'Referer': 'https://naruto.jotagame.com/',
      },
      cf: { cacheEverything: true, cacheTtl: 86400 },
    });

    const headers = new Headers(upstream.headers);
    headers.set('Access-Control-Allow-Origin', '*');
    headers.set('Access-Control-Expose-Headers', 'Content-Length, Content-Type');
    headers.delete('set-cookie');

    return new Response(upstream.body, {
      status: upstream.status,
      headers,
    });
  },
};
`;

const MEDIA_PROXY_TEST_URL = 'https://naruto.jotagame.com/acervo/som/100047_skill_1.mp3';

export interface ProxyMediaTestResult {
  ok: boolean;
  latencyMs: number;
  message: string;
}

export async function testCorsProxyForMedia(proxyBaseUrl: string): Promise<ProxyMediaTestResult> {
  const clean = proxyBaseUrl.trim();
  if (!clean) {
    return { ok: false, latencyMs: 0, message: 'Informe a URL do Proxy CORS.' };
  }
  const testUrl = buildCorsRelayUrl(MEDIA_PROXY_TEST_URL, clean);
  const t0 = performance.now();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    const resp = await fetch(testUrl, {
      cache: 'no-store',
      signal: controller.signal,
    });
    clearTimeout(timer);
    const latencyMs = Math.max(1, Math.round(performance.now() - t0));

    if (!resp.ok) {
      return {
        ok: false,
        latencyMs,
        message: `O proxy respondeu HTTP ${resp.status}. Verifique se o Worker foi publicado (Deploy).`,
      };
    }

    const ct = (resp.headers.get('content-type') || '').toLowerCase();
    const buf = new Uint8Array(await resp.arrayBuffer());
    if (buf.byteLength < 1024) {
      return {
        ok: false,
        latencyMs,
        message: `Resposta muito pequena (${buf.byteLength} bytes). Verifique o código do Worker.`,
      };
    }

    // Reject HTML/JSON error pages disguised as HTTP 200
    const headAscii = new TextDecoder('ascii').decode(buf.slice(0, 64)).trimStart().toLowerCase();
    if (
      ct.includes('text/html') ||
      ct.includes('application/json') ||
      headAscii.startsWith('<!doctype') ||
      headAscii.startsWith('<html') ||
      headAscii.startsWith('{')
    ) {
      return {
        ok: false,
        latencyMs,
        message: 'O proxy devolveu HTML/JSON em vez do arquivo MP3. Verifique o código do Worker.',
      };
    }

    return {
      ok: true,
      latencyMs,
      message: `Proxy ativo (${latencyMs} ms)! MP4 e MP3 liberados em velocidade máxima.`,
    };
  } catch (err) {
    const latencyMs = Math.max(1, Math.round(performance.now() - t0));
    const detail =
      err instanceof DOMException && err.name === 'AbortError'
        ? 'Tempo esgotado (10s).'
        : 'Falha de rede ou CORS bloqueado no proxy informado.';
    return { ok: false, latencyMs, message: detail };
  }
}

export interface DirectDownloadSpec {
  moduleId: string;
  label: string;
  filename: string;
  origin: string;
  paths: string[];
  /** Optional base64-encoded ZIP containing `_shinobi_backup/*` (catalog, skills, combat, sounds, meta) */
  metaArchiveBase64?: string;
}

function triggerTextFileDownload(content: string, filename: string, mime = 'text/plain;charset=utf-8') {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    a.remove();
    URL.revokeObjectURL(url);
  }, 1500);
}

function sanitizeBaseName(filename: string): string {
  return filename.replace(/\.zip$/i, '').replace(/[^a-zA-Z0-9._-]/g, '_');
}

function wrapBase64(b64: string, width = 100): string {
  const out: string[] = [];
  for (let i = 0; i < b64.length; i += width) {
    out.push(b64.slice(i, i + width));
  }
  return out.join('\n');
}

/**
 * Exports a direct HTTPS URL list (.txt) compatible with Android 1DM / ADM and PC IDM / JDownloader.
 * Zero CORS, zero proxy, maximum download speed.
 */
export function downloadDirectUrlList(spec: DirectDownloadSpec): void {
  const originClean = spec.origin.replace(/\/+$/, '');
  const lines = spec.paths.map((p) => `${originClean}/${p.replace(/^\/+/, '')}`);
  const base = sanitizeBaseName(spec.filename);
  triggerTextFileDownload(`${lines.join('\n')}\n`, `links_${base}.txt`);
}

/**
 * Exports a resumable, 16-thread PowerShell script (.ps1) for Windows that downloads all files
 * directly from the origin (bypassing browser CORS completely), unpacks embedded offline metadata
 * (`_shinobi_backup/*`), and packs everything into a single STORE-mode .zip ready for offline playback.
 */
export function downloadDirectWindowsScript(spec: DirectDownloadSpec): void {
  const originClean = spec.origin.replace(/\/+$/, '');
  const base = sanitizeBaseName(spec.filename);
  const zipName = spec.filename.endsWith('.zip') ? spec.filename : `${spec.filename}.zip`;
  const metaJson = JSON.stringify(
    {
      format: 'shinobi-backup-v1',
      createdAt: new Date().toISOString(),
      origin: originClean,
      moduleId: spec.moduleId,
      label: spec.label,
      storeZeroExtra: true,
      expectedFiles: spec.paths.length,
      completedFiles: spec.paths.length,
    },
    null,
    2
  );

  const safePaths = spec.paths
    .map((p) => p.replace(/^\/+/, '').replace(/'/g, "''"))
    .join('\n');

  const metaArchiveBlock = spec.metaArchiveBase64
    ? `$MetaZipB64 = @'
${wrapBase64(spec.metaArchiveBase64)}
'@
$MetaZipPath = Join-Path $WorkDir '_meta_pack.zip'
[IO.File]::WriteAllBytes($MetaZipPath, [Convert]::FromBase64String(($MetaZipB64 -replace '\\s+', '')))
Add-Type -AssemblyName System.IO.Compression.FileSystem
$MetaArchive = [System.IO.Compression.ZipFile]::OpenRead($MetaZipPath)
try {
  foreach ($entry in $MetaArchive.Entries) {
    if ([string]::IsNullOrEmpty($entry.Name)) { continue }
    $destPath = Join-Path $WorkDir ($entry.FullName -replace '/', '\\')
    $destDir = Split-Path -Parent $destPath
    if (-not (Test-Path $destDir)) { New-Item -ItemType Directory -Force -Path $destDir | Out-Null }
    [System.IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $destPath, $true)
  }
} finally {
  $MetaArchive.Dispose()
  Remove-Item -Force $MetaZipPath -ErrorAction SilentlyContinue
}`
    : `$MetaDir = Join-Path $WorkDir '_shinobi_backup'
New-Item -ItemType Directory -Force -Path $MetaDir | Out-Null
@'
${metaJson}
'@ | Set-Content -Encoding UTF8 (Join-Path $MetaDir 'meta.json')`;

  const ps1 = `# Shinobi Sprite Studio - Download Direto em Alta Velocidade (Sem Proxy / Retomavel)
# Modulo: ${spec.label}
# Arquivos: ${spec.paths.length}
# Como usar no Windows: Clique com o botao direito -> "Executar com o PowerShell"
# Se cair a internet, basta executar novamente: ele continua exatamente de onde parou!

$ErrorActionPreference = 'Continue'
$Origin = '${originClean.replace(/'/g, "''")}'
$WorkDir = Join-Path $PSScriptRoot '.shinobi_cache_${base}'
$ZipOut = Join-Path $PSScriptRoot '${zipName.replace(/'/g, "''")}'

$Paths = @'
${safePaths}
'@ -split "\`r?\`n" | Where-Object { $_.Trim() -ne '' }

New-Item -ItemType Directory -Force -Path $WorkDir | Out-Null
Write-Host "============================================================" -ForegroundColor DarkCyan
Write-Host "  Shinobi Sprite Studio - Backup Direto (Windows)" -ForegroundColor Cyan
Write-Host "  Pacote: ${spec.label.replace(/"/g, "'")}" -ForegroundColor Gray
Write-Host "  Arquivos: $($Paths.Count) (16 conexoes paralelas, sem CORS)" -ForegroundColor Gray
Write-Host "============================================================" -ForegroundColor DarkCyan

$Done = 0
$Total = $Paths.Count
$Pending = New-Object System.Collections.Generic.List[string]
foreach ($rel in $Paths) {
  $dest = Join-Path $WorkDir ($rel -replace '/', '\\')
  if ((Test-Path $dest) -and ((Get-Item $dest).Length -gt 0)) {
    $Done++
  } else {
    $Pending.Add($rel)
  }
}

Write-Host "Ja baixados em cache: $Done / $Total. Restantes: $($Pending.Count)" -ForegroundColor Yellow

$MaxJobs = 16
$Pool = [runspacefactory]::CreateRunspacePool(1, $MaxJobs)
$Pool.Open()
$Jobs = New-Object System.Collections.ArrayList

$ScriptBlock = {
  param($OriginUrl, $RelPath, $OutRoot)
  $url = "$OriginUrl/$RelPath"
  $dest = Join-Path $OutRoot ($RelPath -replace '/', '\\')
  $dir = Split-Path -Parent $dest
  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
  $part = "$dest.part"
  for ($try = 1; $try -le 4; $try++) {
    try {
      & curl.exe -fSL --retry 2 --connect-timeout 15 --max-time 180 -C - -o $part $url 2>$null
      if ((Test-Path $part) -and ((Get-Item $part).Length -gt 0)) {
        Move-Item -Force $part $dest
        return $true
      }
    } catch {}
    Start-Sleep -Milliseconds (400 * $try)
  }
  return $false
}

foreach ($rel in $Pending) {
  $ps = [powershell]::Create().AddScript($ScriptBlock).AddArgument($Origin).AddArgument($rel).AddArgument($WorkDir)
  $ps.RunspacePool = $Pool
  [void]$Jobs.Add([pscustomobject]@{ Pipe = $ps; Handle = $ps.BeginInvoke(); Rel = $rel })
}

$Failed = 0
foreach ($job in $Jobs) {
  $ok = $job.Pipe.EndInvoke($job.Handle)
  $job.Pipe.Dispose()
  if ($ok) { $Done++ } else { $Failed++ }
  if (($Done % 15 -eq 0) -or ($Done + $Failed -eq $Total)) {
    $pct = [math]::Round((($Done + $Failed) / [math]::Max(1, $Total)) * 100)
    Write-Progress -Activity "Baixando ${base}" -Status "$Done / $Total concluido(s) ($Failed falhas)" -PercentComplete $pct
  }
}
$Pool.Close()
$Pool.Dispose()

Write-Host "Gravando catalogo, habilidades e dados de combate offline..." -ForegroundColor Cyan
${metaArchiveBlock}

Write-Host "Empacotando arquivo unico $ZipOut em modo STORE (leitura instantanea no app)..." -ForegroundColor Cyan
if (Test-Path $ZipOut) { Remove-Item -Force $ZipOut }
Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::CreateFromDirectory($WorkDir, $ZipOut, [System.IO.Compression.CompressionLevel]::NoCompression, $false)

if ($Failed -eq 0) {
  Write-Host "Limpando cache temporario..." -ForegroundColor DarkGray
  Remove-Item -Recurse -Force $WorkDir -ErrorAction SilentlyContinue
  Write-Host "PRONTO! Backup 100% completo salvo em: $ZipOut ($Done/$Total arquivos)." -ForegroundColor Green
} else {
  Write-Host "Backup gerado em $ZipOut ($Done/$Total). $Failed arquivo(s) falharam." -ForegroundColor Yellow
  Write-Host "Cache mantido: execute este script novamente para baixar apenas o que faltou." -ForegroundColor Yellow
}
Write-Host "Abra esse .zip na aba 'Backup -> Abrir ZIP local' do Shinobi Sprite Studio!" -ForegroundColor Green
Pause
`;

  triggerTextFileDownload(ps1, `baixar_${base}.ps1`);
}

/**
 * Exports a turbo, resumable 16-connection HTTP/1.1 Keep-Alive script (.sh) tailored for
 * Android (Termux), Linux, and macOS:
 * - Zero CORS, zero proxy, maximum download speed via persistent TLS sockets
 * - On Android Termux: auto-installs python if needed, caches temp files inside fast internal
 *   Termux storage ($HOME/.shinobi_cache) to avoid slow Android FUSE & MediaStore gallery clutter,
 *   and saves the final single ZIP64 STORE file directly into Android Downloads ($HOME/storage/downloads)
 * - Unpacks embedded `_shinobi_backup/*` (catalog, skills, combat/chase, sounds) automatically
 * - Writes `SHINOBI_BACKUP_V1:STORE_ZERO_EXTRA` archive comment for instant zero-copy playback
 */
export function downloadDirectUnixScript(spec: DirectDownloadSpec): void {
  const originClean = spec.origin.replace(/\/+$/, '');
  const base = sanitizeBaseName(spec.filename);
  const zipName = spec.filename.endsWith('.zip') ? spec.filename : `${spec.filename}.zip`;
  const metaJson = JSON.stringify(
    {
      format: 'shinobi-backup-v1',
      createdAt: new Date().toISOString(),
      origin: originClean,
      moduleId: spec.moduleId,
      label: spec.label,
      storeZeroExtra: true,
      expectedFiles: spec.paths.length,
      completedFiles: spec.paths.length,
    },
    null,
    2
  );

  const safePaths = spec.paths.map((p) => p.replace(/^\/+/, '')).join('\n');
  const wrappedMetaB64 = spec.metaArchiveBase64 ? wrapBase64(spec.metaArchiveBase64) : '';

  const sh = `#!/usr/bin/env bash
# ==============================================================================
# Shinobi Sprite Studio - Download Direto Turbo (1 Unico ZIP, Sem CORS, Retomavel)
# Otimizado para Android (Termux), Linux e macOS
# Pacote: ${spec.label} (${spec.paths.length} arquivos)
#
# Como usar no Android (Termux):
#   1) Instale o Termux (recomendado: F-Droid ou GitHub)
#   2) Rode: termux-setup-storage && bash ~/storage/downloads/baixar_${base}.sh
#
# Como usar no Linux / macOS:
#   bash baixar_${base}.sh
#
# Se a internet cair ou o celular fechar o app, basta rodar de novo:
# o download retoma exatamente do arquivo onde parou!
# ==============================================================================

set -u

ORIGIN="${originClean}"
BASE_NAME="${base}"
ZIP_NAME="${zipName}"

IS_TERMUX=0
if [ -n "\${TERMUX_VERSION:-}" ] || [ -d "/data/data/com.termux" ]; then
  IS_TERMUX=1
fi

echo ""
echo "============================================================"
echo "  Shinobi Sprite Studio - Backup Completo (1 Unico ZIP)"
echo "  Pacote: ${spec.label.replace(/"/g, "'")}"
echo "  Arquivos: ${spec.paths.length}"
echo "============================================================"

# 1) Garantir Python 3 (usado para conexoes HTTP/1.1 Keep-Alive + empacotamento ZIP64 STORE)
if ! command -v python3 >/dev/null 2>&1; then
  if [ "$IS_TERMUX" -eq 1 ]; then
    echo "[Android Termux] Instalando Python automaticamente..."
    pkg update -y >/dev/null 2>&1 || true
    pkg install -y python || {
      echo "Erro ao instalar Python no Termux. Rode manualmente: pkg install -y python"
      exit 1
    }
  else
    echo "Erro: python3 nao encontrado. Instale python3 e rode este script novamente."
    exit 1
  fi
fi

# 2) Definir pastas otimizadas (no Android: cache interno rapido, ZIP final em Downloads)
if [ "$IS_TERMUX" -eq 1 ]; then
  if [ ! -d "$HOME/storage/downloads" ]; then
    echo "[Android Termux] Solicitando acesso a pasta Downloads (aceite a permissao na tela)..."
    termux-setup-storage || true
    for _ in 1 2 3 4 5 6 7 8 9 10; do
      [ -d "$HOME/storage/downloads" ] && break
      sleep 1
    done
  fi
  if [ -d "$HOME/storage/downloads" ]; then
    OUT_DIR="$HOME/storage/downloads"
  else
    OUT_DIR="$HOME/shinobi_backup"
    mkdir -p "$OUT_DIR"
    echo "[Aviso] Permissao de Downloads nao detectada. O ZIP sera salvo em: $OUT_DIR"
  fi
  # Cache dentro do armazenamento interno do Termux: 10x mais rapido e nao polui a Galeria!
  WORKDIR="$HOME/.shinobi_cache/$BASE_NAME"
  # Evita que o Android congele o Termux com a tela apagada (se disponivel)
  command -v termux-wake-lock >/dev/null 2>&1 && termux-wake-lock || true
else
  OUT_DIR="."
  WORKDIR="./.shinobi_cache/$BASE_NAME"
fi

ZIPOUT="$OUT_DIR/$ZIP_NAME"
mkdir -p "$WORKDIR/_shinobi_backup"

LISTFILE="$WORKDIR/_paths_manifest.txt"
METAB64FILE="$WORKDIR/_meta_archive.b64"
METAJSONFILE="$WORKDIR/_meta_fallback.json"

cat <<'EOF_PATHS' > "$LISTFILE"
${safePaths}
EOF_PATHS

cat <<'EOF_META_JSON' > "$METAJSONFILE"
${metaJson}
EOF_META_JSON

cat <<'EOF_META_B64' > "$METAB64FILE"
${wrappedMetaB64}
EOF_META_B64

echo "Cache temporario: $WORKDIR"
echo "Arquivo final:    $ZIPOUT"
echo ""

python3 - "$ORIGIN" "$WORKDIR" "$ZIPOUT" "$LISTFILE" "$METAB64FILE" "$METAJSONFILE" <<'PY_ENGINE'
import base64
import concurrent.futures
import http.client
import io
import os
import shutil
import ssl
import sys
import threading
import time
import urllib.parse
import zipfile

origin, workdir, zipout, listfile, metab64file, metajsonfile = sys.argv[1:7]

MAX_WORKERS = 16
ARCHIVE_COMMENT = b"SHINOBI_BACKUP_V1:STORE_ZERO_EXTRA"

# 1) Descompactar metadados offline embutidos (_shinobi_backup/*: catalogo, skills, combate, sons)
with open(metab64file, "r", encoding="utf-8") as f:
    b64_raw = "".join(f.read().split())

if b64_raw:
    try:
        meta_bytes = base64.b64decode(b64_raw)
        with zipfile.ZipFile(io.BytesIO(meta_bytes), "r") as mzf:
            for member in mzf.infolist():
                if member.is_dir():
                    continue
                rel_member = member.filename.lstrip("/").replace("\\\\", "/")
                if ".." in rel_member.split("/"):
                    continue
                target = os.path.join(workdir, *rel_member.split("/"))
                os.makedirs(os.path.dirname(target), exist_ok=True)
                with mzf.open(member, "r") as src, open(target, "wb") as dst:
                    shutil.copyfileobj(src, dst)
    except Exception as exc:
        print(f"[Aviso] Falha ao extrair metadados embutidos: {exc}")

meta_json_dest = os.path.join(workdir, "_shinobi_backup", "meta.json")
if not os.path.exists(meta_json_dest):
    os.makedirs(os.path.dirname(meta_json_dest), exist_ok=True)
    shutil.copyfile(metajsonfile, meta_json_dest)

# 2) Ler lista de arquivos e verificar quais ja estao no cache (retomada instantanea)
with open(listfile, "r", encoding="utf-8") as f:
    all_paths = [line.strip().lstrip("/") for line in f if line.strip()]

total = len(all_paths)
pending = []
done_count = 0
already_bytes = 0

for rel in all_paths:
    dest = os.path.join(workdir, *rel.split("/"))
    if os.path.isfile(dest):
        sz = os.path.getsize(dest)
        if sz > 0:
            done_count += 1
            already_bytes += sz
            continue
    pending.append(rel)

def fmt_size(b):
    if b >= 1024 * 1024 * 1024:
        return f"{b / (1024**3):.2f} GB"
    if b >= 1024 * 1024:
        return f"{b / (1024**2):.1f} MB"
    return f"{max(1, int(b / 1024))} KB"

def fmt_eta(sec):
    if sec is None or sec <= 0 or sec > 86400 * 7:
        return "--"
    sec = int(sec)
    h, rem = divmod(sec, 3600)
    m, s = divmod(rem, 60)
    if h > 0:
        return f"{h}h{m:02d}m"
    if m > 0:
        return f"{m}m{s:02d}s"
    return f"{s}s"

print(f"Total: {total} arquivos | Em cache: {done_count} ({fmt_size(already_bytes)}) | Restantes: {len(pending)}")
print(f"Conectando direto em {origin} ({MAX_WORKERS} conexoes HTTP/1.1 Keep-Alive, sem CORS)...")

parsed_origin = urllib.parse.urlsplit(origin)
origin_scheme = parsed_origin.scheme or "https"
origin_host = parsed_origin.hostname
origin_port = parsed_origin.port or (443 if origin_scheme == "https" else 80)
ssl_ctx = ssl.create_default_context()

thread_local = threading.local()
lock = threading.Lock()
failed_paths = []
missing_404 = 0
session_bytes = 0
start_ts = time.monotonic()
last_print_ts = 0.0

def get_conn(scheme, host, port):
    key = (scheme, host, port)
    conns = getattr(thread_local, "conns", None)
    if conns is None:
        conns = {}
        thread_local.conns = conns
    conn = conns.get(key)
    if conn is None:
        if scheme == "https":
            conn = http.client.HTTPSConnection(host, port, timeout=30, context=ssl_ctx)
        else:
            conn = http.client.HTTPConnection(host, port, timeout=30)
        conns[key] = conn
    return conn

def reset_conn(scheme, host, port):
    conns = getattr(thread_local, "conns", None)
    if not conns:
        return
    conn = conns.pop((scheme, host, port), None)
    if conn is not None:
        try:
            conn.close()
        except Exception:
            pass

def download_one(rel):
    global done_count, missing_404, session_bytes, last_print_ts
    dest = os.path.join(workdir, *rel.split("/"))
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    part = dest + ".part"
    encoded_path = "/" + urllib.parse.quote(rel, safe="/:@!$&'()*+,;=-._~")

    scheme, host, port, req_path = origin_scheme, origin_host, origin_port, encoded_path
    headers = {
        "User-Agent": "Mozilla/5.0 (Linux; Android 14) ShinobiBackup/2.0",
        "Referer": origin + "/",
        "Connection": "keep-alive",
    }

    ok = False
    is_404 = False
    file_bytes = 0

    for attempt in range(4):
        try:
            cur_scheme, cur_host, cur_port, cur_path = scheme, host, port, req_path
            for _redir in range(4):
                conn = get_conn(cur_scheme, cur_host, cur_port)
                conn.request("GET", cur_path, headers=headers)
                resp = conn.getresponse()
                if resp.status in (301, 302, 303, 307, 308):
                    loc = resp.getheader("Location")
                    resp.read()
                    if not loc:
                        break
                    u = urllib.parse.urlsplit(urllib.parse.urljoin(f"{cur_scheme}://{cur_host}{cur_path}", loc))
                    cur_scheme = u.scheme or cur_scheme
                    cur_host = u.hostname or cur_host
                    cur_port = u.port or (443 if cur_scheme == "https" else 80)
                    cur_path = u.path + (f"?{u.query}" if u.query else "")
                    continue

                if resp.status == 200:
                    written = 0
                    with open(part, "wb") as out_f:
                        while True:
                            chunk = resp.read(131072)
                            if not chunk:
                                break
                            out_f.write(chunk)
                            written += len(chunk)
                    if written > 0:
                        os.replace(part, dest)
                        ok = True
                        file_bytes = written
                        break
                    else:
                        try:
                            os.remove(part)
                        except OSError:
                            pass
                elif resp.status == 404:
                    resp.read()
                    is_404 = True
                    break
                else:
                    resp.read()
                break

            if ok or is_404:
                break
            reset_conn(cur_scheme, cur_host, cur_port)
        except Exception:
            reset_conn(scheme, host, port)
        time.sleep(0.35 * (attempt + 1))

    with lock:
        if ok:
            done_count += 1
            session_bytes += file_bytes
        elif is_404:
            missing_404 += 1
        else:
            failed_paths.append(rel)
        now = time.monotonic()
        processed = done_count + missing_404 + len(failed_paths)
        if processed == total or (now - last_print_ts) >= 0.4:
            last_print_ts = now
            elapsed = max(0.1, now - start_ts)
            speed = session_bytes / elapsed
            pct = (processed / max(1, total)) * 100.0
            remaining_files = max(0, total - processed)
            rate_files = (processed - (total - len(pending))) / elapsed if elapsed > 0 else 0
            eta = (remaining_files / rate_files) if rate_files > 0.05 else None
            line = (
                f"\\r[{done_count}/{total}] {pct:5.1f}% | "
                f"{fmt_size(session_bytes + already_bytes)} | "
                f"{fmt_size(speed)}/s | ETA {fmt_eta(eta)} | Falhas: {len(failed_paths)}   "
            )
            sys.stdout.write(line)
            sys.stdout.flush()

    return ok

if pending:
    with concurrent.futures.ThreadPoolExecutor(max_workers=MAX_WORKERS) as pool:
        list(pool.map(download_one, pending))
    print("")
else:
    print("Todos os arquivos ja estavam no cache local!")

# Remover arquivos auxiliares de controle antes de empacotar
for tmp_ctl in (listfile, metab64file, metajsonfile):
    try:
        os.remove(tmp_ctl)
    except OSError:
        pass

# 3) Empacotar tudo em 1 UNICO arquivo ZIP64 STORE (sem recompressao, leitura instantanea no app)
print("")
print(f"Empacotando arquivo unico (ZIP64 STORE): {zipout}")
os.makedirs(os.path.dirname(os.path.abspath(zipout)), exist_ok=True)
tmp_zip = (zipout[:-4] + ".tmp.zip") if zipout.lower().endswith(".zip") else (zipout + ".tmp.zip")
if os.path.exists(tmp_zip):
    os.remove(tmp_zip)

files_to_pack = []
for dirpath, _, filenames in os.walk(workdir):
    for fn in filenames:
        if fn.endswith(".part") or fn.startswith("_paths_manifest") or fn.startswith("_meta_"):
            continue
        full = os.path.join(dirpath, fn)
        arc = os.path.relpath(full, workdir).replace(os.sep, "/")
        files_to_pack.append((full, arc))

files_to_pack.sort(key=lambda item: (0 if item[1].startswith("_shinobi_backup/") else 1, item[1]))
pack_total = len(files_to_pack)
pack_start = time.monotonic()

with zipfile.ZipFile(tmp_zip, "w", compression=zipfile.ZIP_STORED, allowZip64=True) as zf:
    zf.comment = ARCHIVE_COMMENT
    for idx, (full, arc) in enumerate(files_to_pack, 1):
        zf.write(full, arc)
        if idx == pack_total or idx % 200 == 0:
            pct = (idx / max(1, pack_total)) * 100.0
            sys.stdout.write(f"\\rEmpacotando: [{idx}/{pack_total}] {pct:5.1f}%   ")
            sys.stdout.flush()

os.replace(tmp_zip, zipout)
final_size = os.path.getsize(zipout)
print("")
print(f"Empacotamento concluido em {time.monotonic() - pack_start:.1f}s ({fmt_size(final_size)}).")

if len(failed_paths) == 0:
    print("Limpando cache temporario para liberar espaco no dispositivo...")
    shutil.rmtree(workdir, ignore_errors=True)
    print("")
    print("============================================================")
    print("  PRONTO! BACKUP 100% COMPLETO EM 1 UNICO ARQUIVO!")
    print(f"  Salvo em: {zipout}")
    print(f"  Tamanho:  {fmt_size(final_size)} ({pack_total} arquivos)")
    print("  Agora abra este .zip no Shinobi Sprite Studio ->")
    print("  aba 'Backup' -> 'Abrir ZIP local'!")
    print("============================================================")
else:
    print("")
    print(f"AVISO: {len(failed_paths)} arquivo(s) nao puderam ser baixados.")
    print(f"ZIP parcial salvo em: {zipout}")
    print("O cache temporario foi mantido. Execute o script novamente para baixar apenas os que faltaram.")
PY_ENGINE

if [ "$IS_TERMUX" -eq 1 ]; then
  if [ -f "$ZIPOUT" ]; then
    command -v termux-media-scan >/dev/null 2>&1 && termux-media-scan "$ZIPOUT" >/dev/null 2>&1 || true
  fi
  command -v termux-wake-unlock >/dev/null 2>&1 && termux-wake-unlock || true
fi
`;

  triggerTextFileDownload(sh, `baixar_${base}.sh`, 'text/x-shellscript;charset=utf-8');
}

export type FullGameMirrorScope = 'all_files' | 'database_only';

export interface FullGameMirrorSpec {
  origin: string;
  scope: FullGameMirrorScope;
  /** Optional base64-encoded ZIP containing `_shinobi_backup/*` so the resulting ZIP also opens in the Studio offline */
  metaArchiveBase64?: string;
}

/**
 * Generates a self-updating turbo Termux / Linux / macOS script (.sh) that fetches the live
 * `recursos-manifesto.*.json` directly from the origin (zero CORS), downloads either:
 *  - `all_files`: 100% of all ~81,176+ files in the game manifest (~13 GB)
 *  - `database_only`: all 3,215 `d/*` database tables + 346 `j/*` JS/CSS + `lib/*` + HTML/manifests (~50 MB)
 * Automatically decrypts ALL 3,215 `d/*` AES-256-GCM+gzip files into human-readable JSON inside
 * `banco_de_dados_legivel/` with original filenames recovered from JS bundles and internal metadata,
 * and packs everything into 1 single ZIP64 STORE archive (with `EMPACOTAR_ZIP=0` option for raw folder).
 */
export function downloadFullGameMirrorUnixScript(spec: FullGameMirrorSpec): string {
  const originClean = spec.origin.replace(/\/+$/, '');
  const isAll = spec.scope === 'all_files';
  const baseName = isAll ? 'shinobi_jogo_completo_tudo' : 'shinobi_banco_de_dados_completo';
  const zipName = `${baseName}.zip`;
  const scriptFilename = isAll
    ? 'baixar_jogo_completo_tudo.sh'
    : 'baixar_banco_de_dados_completo.sh';
  const label = isAll
    ? 'Copia Completa do Jogo — 100% de Todos os Arquivos (~81.000+ arquivos, ~13 GB)'
    : 'Banco de Dados Completo + Codigo Cliente (3.215 tabelas JSON + JS/CSS + Libs)';
  const wrappedMetaB64 = spec.metaArchiveBase64 ? wrapBase64(spec.metaArchiveBase64) : '';

  const sh = `#!/usr/bin/env bash
# ==============================================================================
# Shinobi Sprite Studio - Extrator Completo do Jogo & Banco de Dados (Termux / Linux / macOS)
# Modo: ${label}
# Origem: ${originClean}
#
# O QUE ESTE SCRIPT FAZ AUTOMATICAMENTE:
#   1) Busca o manifesto oficial mais recente ao vivo (/jogar?app=1 -> recursos-manifesto.*.json)
#   2) Baixa todos os arquivos em 16 conexoes HTTP/1.1 Keep-Alive (sem CORS, retomavel por tamanho exato)
#   3) Descriptografa TODAS as 3.215 tabelas d/* para JSON legivel em banco_de_dados_legivel/
#      recuperando os nomes originais (herois.json, skills.json, pt.json, RoleModel.json, etc.)
#   4) Empacota tudo em 1 UNICO arquivo ZIP64 STORE direto na pasta Downloads
#
# Como usar no Android (Termux - F-Droid / GitHub):
#   termux-setup-storage && bash ~/storage/downloads/${scriptFilename}
#
# Dica de espaco no celular (apenas se tiver menos de 26 GB livres para a copia de 13 GB):
#   EMPACOTAR_ZIP=0 bash ~/storage/downloads/${scriptFilename}
#   (mantem os arquivos organizados em pasta sem precisar do dobro de espaco para zipar)
# ==============================================================================

set -u

ORIGIN="${originClean}"
SCOPE="${spec.scope}"
BASE_NAME="${baseName}"
ZIP_NAME="${zipName}"
EMPACOTAR_ZIP="\${EMPACOTAR_ZIP:-1}"

IS_TERMUX=0
if [ -n "\${TERMUX_VERSION:-}" ] || [ -d "/data/data/com.termux" ]; then
  IS_TERMUX=1
fi

echo ""
echo "============================================================"
echo "  ${label}"
echo "  Origem: $ORIGIN"
echo "============================================================"

# 1) Garantir Python 3 + modulo de descriptografia (python-cryptography ou nodejs)
if ! command -v python3 >/dev/null 2>&1; then
  if [ "$IS_TERMUX" -eq 1 ]; then
    echo "[Android Termux] Instalando Python automaticamente..."
    pkg update -y >/dev/null 2>&1 || true
    pkg install -y python || {
      echo "Erro ao instalar Python no Termux. Rode manualmente: pkg install -y python"
      exit 1
    }
  else
    echo "Erro: python3 nao encontrado. Instale python3 e execute novamente."
    exit 1
  fi
fi

if ! python3 -c "import cryptography" >/dev/null 2>&1 && ! command -v node >/dev/null 2>&1; then
  if [ "$IS_TERMUX" -eq 1 ]; then
    echo "[Android Termux] Instalando motor de descriptografia das tabelas (python-cryptography)..."
    pkg update -y >/dev/null 2>&1 || true
    pkg install -y python-cryptography >/dev/null 2>&1 || pkg install -y nodejs-lts >/dev/null 2>&1 || pkg install -y nodejs >/dev/null 2>&1 || true
  fi
fi

# 2) Configurar pastas (no Android: cache interno rapido no Termux, saida em Downloads)
if [ "$IS_TERMUX" -eq 1 ]; then
  if [ ! -d "$HOME/storage/downloads" ]; then
    echo "[Android Termux] Solicitando acesso a pasta Downloads (aceite na tela)..."
    termux-setup-storage || true
    for _ in 1 2 3 4 5 6 7 8 9 10; do
      [ -d "$HOME/storage/downloads" ] && break
      sleep 1
    done
  fi
  if [ -d "$HOME/storage/downloads" ]; then
    OUT_DIR="$HOME/storage/downloads"
  else
    OUT_DIR="$HOME/shinobi_backup"
    mkdir -p "$OUT_DIR"
    echo "[Aviso] Permissao de Downloads nao detectada. Saida sera salva em: $OUT_DIR"
  fi
  if [ "$EMPACOTAR_ZIP" = "0" ]; then
    WORKDIR="$OUT_DIR/$BASE_NAME"
  else
    WORKDIR="$HOME/.shinobi_cache/$BASE_NAME"
  fi
  command -v termux-wake-lock >/dev/null 2>&1 && termux-wake-lock || true
else
  OUT_DIR="."
  if [ "$EMPACOTAR_ZIP" = "0" ]; then
    WORKDIR="./$BASE_NAME"
  else
    WORKDIR="./.shinobi_cache/$BASE_NAME"
  fi
fi

ZIPOUT="$OUT_DIR/$ZIP_NAME"
mkdir -p "$WORKDIR"

METAB64FILE="$WORKDIR/_meta_archive.b64"
cat <<'EOF_META_B64' > "$METAB64FILE"
${wrappedMetaB64}
EOF_META_B64

echo "Pasta de trabalho: $WORKDIR"
if [ "$EMPACOTAR_ZIP" = "1" ]; then
  echo "Arquivo ZIP final: $ZIPOUT"
else
  echo "Modo pasta direta: $WORKDIR (sem empacotamento .zip)"
fi
echo ""

python3 - "$ORIGIN" "$SCOPE" "$WORKDIR" "$ZIPOUT" "$METAB64FILE" "$EMPACOTAR_ZIP" <<'PY_MIRROR'
import base64
import concurrent.futures
import gzip
import hashlib
import hmac
import http.client
import io
import json
import os
import re
import shutil
import ssl
import subprocess
import sys
import threading
import time
import urllib.parse
import urllib.request
import zipfile

origin, scope, workdir, zipout, metab64file, empacotar_flag = sys.argv[1:7]
pack_zip = empacotar_flag != "0"
MAX_WORKERS = 16
ARCHIVE_COMMENT = b"SHINOBI_BACKUP_V1:STORE_ZERO_EXTRA"

JOTA_DD = [
    0xeb, 0x14, 0x79, 0xb3, 0xa9, 0xd6, 0x0c, 0x6e, 0x2d, 0x7c, 0x0f, 0x45, 0xc3, 0x45, 0x8f, 0x0d,
    0xcc, 0x7f, 0x81, 0x52, 0xfa, 0xb1, 0x4b, 0xc1, 0x7c, 0x49, 0x5b, 0x52, 0x69, 0x3b, 0xfd, 0x96,
]
JOTA_CD = [
    0x5c, 0x16, 0x0c, 0x5a, 0x22, 0x5e, 0xb5, 0xd2, 0xb4, 0xc6, 0xca, 0xef, 0xbe, 0xbf, 0xde, 0xc2,
    0x95, 0xc0, 0x60, 0xac, 0xf0, 0x7a, 0xd6, 0x64, 0x48, 0x23, 0xec, 0xa8, 0xdb, 0xa0, 0x14, 0xaf,
]
MASTER_KEY = bytes(a ^ b for a, b in zip(JOTA_DD, JOTA_CD))
NOME_KEY = hmac.new(MASTER_KEY, b"nome", hashlib.sha256).digest()
DADOS_KEY = hmac.new(MASTER_KEY, b"dados", hashlib.sha256).digest()

KNOWN_DADOS_PATHS = [
    "dados/jogo/herois.json",
    "dados/jogo/skills.json",
    "dados/jogo/pt.json",
    "dados/jogo/sons.json",
    "dados/jogo/itens.json",
    "dados/jogo/campanha.json",
    "dados/jogo/clipes.json",
    "dados/jogo/invocacoes.json",
    "dados/jogo/talentos.json",
    "dados/jogo/mapas.json",
    "dados/jogo/missoes.json",
    "dados/jogo/eventos.json",
    "dados/jogo/lojas.json",
    "dados/jogo/equipamentos.json",
    "dados/jogo/guilda.json",
    "dados/tabelas/json/RoleModel.json",
    "dados/tabelas/json/SkinConfig.json",
    "dados/tabelas/json/ConfigValue.json",
    "dados/tabelas/json/FighterConfigForBattle.json",
    "dados/tabelas/json/FormationEquipBase.json",
    "dados/tabelas/json/HeadFrameConfig.json",
    "dados/tabelas/json/HeroQualityRate.json",
    "dados/tabelas/json/PlayerHeadModel.json",
    "dados/tabelas/json/HeroBase.json",
    "dados/tabelas/json/SkillBase.json",
    "dados/tabelas/json/BuffBase.json",
    "dados/tabelas/json/ItemBase.json",
    "dados/tabelas/json/SummonBase.json",
    "dados/telas/NewCommonNodes.json",
]

def slug_for(path_str):
    digest = hmac.new(NOME_KEY, path_str.encode("utf-8"), hashlib.sha256).digest()[:16]
    return "d/" + base64.urlsafe_b64encode(digest).decode("ascii").rstrip("=")

def fmt_size(b):
    if b >= 1024 ** 3:
        return f"{b / (1024**3):.2f} GB"
    if b >= 1024 ** 2:
        return f"{b / (1024**2):.1f} MB"
    return f"{max(1, int(b / 1024))} KB"

def fmt_eta(sec):
    if sec is None or sec <= 0 or sec > 86400 * 14:
        return "--"
    sec = int(sec)
    h, rem = divmod(sec, 3600)
    m, s = divmod(rem, 60)
    if h > 0:
        return f"{h}h{m:02d}m"
    if m > 0:
        return f"{m}m{s:02d}s"
    return f"{s}s"

def fetch_bytes(url):
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": "Mozilla/5.0 (Linux; Android 14) ShinobiMirror/2.0",
            "Referer": origin + "/",
        },
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        return resp.read()

# 1) Extrair metadados _shinobi_backup/* embutidos (para abrir offline no Shinobi Studio tambem)
if os.path.isfile(metab64file):
    with open(metab64file, "r", encoding="utf-8") as f:
        b64_raw = "".join(f.read().split())
    if b64_raw:
        try:
            with zipfile.ZipFile(io.BytesIO(base64.b64decode(b64_raw)), "r") as mzf:
                for member in mzf.infolist():
                    if member.is_dir():
                        continue
                    rel_member = member.filename.lstrip("/").replace("\\\\", "/")
                    if ".." in rel_member.split("/"):
                        continue
                    target = os.path.join(workdir, *rel_member.split("/"))
                    os.makedirs(os.path.dirname(target), exist_ok=True)
                    with mzf.open(member, "r") as src, open(target, "wb") as dst:
                        shutil.copyfileobj(src, dst)
        except Exception as exc:
            print(f"[Aviso] Falha ao extrair metadados embutidos: {exc}")
    try:
        os.remove(metab64file)
    except OSError:
        pass

# 2) Buscar pagina /jogar?app=1 e o manifesto completo ao vivo
print("[1/4] Buscando manifesto ao vivo do servidor...")
html_bytes = fetch_bytes(origin + "/jogar?app=1")
html_text = html_bytes.decode("utf-8", errors="replace")
with open(os.path.join(workdir, "jogar.html"), "wb") as f:
    f.write(html_bytes)

m_rec = re.search(r"window\\.__VDF_RECURSOS__\\s*=\\s*(\\{[^}]*\\})", html_text)
if not m_rec:
    print("Erro: nao foi possivel localizar window.__VDF_RECURSOS__ em /jogar?app=1.")
    sys.exit(1)

rec_obj = json.loads(m_rec.group(1))
manifest_rel = rec_obj.get("manifesto", "")
partes_rel = rec_obj.get("partes", "")
if not manifest_rel:
    print("Erro: campo manifesto vazio em __VDF_RECURSOS__.")
    sys.exit(1)

manifest_url = urllib.parse.urljoin(origin + "/", manifest_rel)
manifest_bytes = fetch_bytes(manifest_url)
man = json.loads(manifest_bytes.decode("utf-8"))
with open(os.path.join(workdir, "recursos-manifesto.json"), "wb") as f:
    f.write(manifest_bytes)

if partes_rel:
    try:
        partes_bytes = fetch_bytes(urllib.parse.urljoin(origin + "/", partes_rel))
        with open(os.path.join(workdir, "recursos-indice.json"), "wb") as f:
            f.write(partes_bytes)
    except Exception:
        pass

try:
    pwa_bytes = fetch_bytes(origin + "/manifest.json")
    with open(os.path.join(workdir, "manifest.json"), "wb") as f:
        f.write(pwa_bytes)
except Exception:
    pass

dados_versao = str(man.get("dadosVersao") or "0")
arquivos_raw = list((man.get("arquivos") or {}).values())

# Filtrar arquivos conforme o escopo escolhido
items = []
seen_urls = set()
for entry in arquivos_raw:
    rel = str(entry.get("url") or "").strip().lstrip("/")
    if not rel or rel in seen_urls:
        continue
    if scope == "database_only":
        if not (
            rel.startswith("d/")
            or rel.startswith("j/")
            or rel.startswith("lib/")
            or rel == "acervo/asset/spine-hd/indice.json"
            or rel == "acervo/asset/spine-astc/lista.json"
        ):
            continue
    seen_urls.add(rel)
    expected_bytes = int(entry.get("bytes") or 0)
    items.append((rel, expected_bytes))

# Garantir scripts raiz referenciados no HTML
for m_src in re.findall(r"""(?:src|href)=["']([^"']+)["']""", html_text):
    clean = m_src.split("?")[0].lstrip("/")
    if not clean or clean.startswith("http") or clean.startswith("data:") or clean in seen_urls:
        continue
    if scope == "database_only" and not (clean.startswith("j/") or clean.startswith("lib/")):
        continue
    seen_urls.add(clean)
    items.append((clean, 0))

total = len(items)
total_estimated_bytes = sum(sz for _, sz in items)

# Verificar espaco livre em disco
try:
    usage = shutil.disk_usage(workdir)
    print(f"Manifesto carregado: {total} arquivos ({fmt_size(total_estimated_bytes)})")
    print(f"Espaco livre no dispositivo: {fmt_size(usage.free)}")
    if pack_zip and total_estimated_bytes > 0 and usage.free < total_estimated_bytes * 1.9:
        print("[Aviso] Espaco livre pode ficar apertado para manter cache + ZIP ao mesmo tempo.")
        print("        Se faltar espaco ao empacotar, rode com: EMPACOTAR_ZIP=0 bash ...")
except Exception:
    print(f"Manifesto carregado: {total} arquivos ({fmt_size(total_estimated_bytes)})")

# 3) Verificar cache local (retomada exata por tamanho em bytes)
pending = []
done_count = 0
already_bytes = 0

for rel, exp_sz in items:
    dest = os.path.join(workdir, *rel.split("/"))
    if os.path.isfile(dest):
        cur_sz = os.path.getsize(dest)
        if cur_sz > 0 and (exp_sz == 0 or cur_sz == exp_sz):
            done_count += 1
            already_bytes += cur_sz
            continue
    pending.append((rel, exp_sz))

print(f"[2/4] Em cache: {done_count}/{total} ({fmt_size(already_bytes)}) | Faltam baixar: {len(pending)}")
print(f"Conectando direto em {origin} ({MAX_WORKERS} conexoes HTTP/1.1 Keep-Alive, sem CORS)...")

parsed_origin = urllib.parse.urlsplit(origin)
origin_scheme = parsed_origin.scheme or "https"
origin_host = parsed_origin.hostname
origin_port = parsed_origin.port or (443 if origin_scheme == "https" else 80)
ssl_ctx = ssl.create_default_context()

thread_local = threading.local()
lock = threading.Lock()
failed_paths = []
missing_404 = 0
session_bytes = 0
start_ts = time.monotonic()
last_print_ts = 0.0

def get_conn(scheme, host, port):
    key = (scheme, host, port)
    conns = getattr(thread_local, "conns", None)
    if conns is None:
        conns = {}
        thread_local.conns = conns
    conn = conns.get(key)
    if conn is None:
        if scheme == "https":
            conn = http.client.HTTPSConnection(host, port, timeout=35, context=ssl_ctx)
        else:
            conn = http.client.HTTPConnection(host, port, timeout=35)
        conns[key] = conn
    return conn

def reset_conn(scheme, host, port):
    conns = getattr(thread_local, "conns", None)
    if not conns:
        return
    conn = conns.pop((scheme, host, port), None)
    if conn is not None:
        try:
            conn.close()
        except Exception:
            pass

def download_one(item):
    global done_count, missing_404, session_bytes, last_print_ts
    rel, _exp_sz = item
    dest = os.path.join(workdir, *rel.split("/"))
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    part = dest + ".part"
    encoded_path = "/" + urllib.parse.quote(rel, safe="/:@!$&'()*+,;=-._~")
    if rel.startswith("d/"):
        encoded_path = f"{encoded_path}?v={dados_versao}"

    scheme, host, port, req_path = origin_scheme, origin_host, origin_port, encoded_path
    headers = {
        "User-Agent": "Mozilla/5.0 (Linux; Android 14) ShinobiMirror/2.0",
        "Referer": origin + "/",
        "Connection": "keep-alive",
    }

    ok = False
    is_404 = False
    file_bytes = 0

    for attempt in range(4):
        try:
            cur_scheme, cur_host, cur_port, cur_path = scheme, host, port, req_path
            for _redir in range(4):
                conn = get_conn(cur_scheme, cur_host, cur_port)
                conn.request("GET", cur_path, headers=headers)
                resp = conn.getresponse()
                if resp.status in (301, 302, 303, 307, 308):
                    loc = resp.getheader("Location")
                    resp.read()
                    if not loc:
                        break
                    u = urllib.parse.urlsplit(urllib.parse.urljoin(f"{cur_scheme}://{cur_host}{cur_path}", loc))
                    cur_scheme = u.scheme or cur_scheme
                    cur_host = u.hostname or cur_host
                    cur_port = u.port or (443 if cur_scheme == "https" else 80)
                    cur_path = u.path + (f"?{u.query}" if u.query else "")
                    continue

                if resp.status == 200:
                    written = 0
                    with open(part, "wb") as out_f:
                        while True:
                            chunk = resp.read(131072)
                            if not chunk:
                                break
                            out_f.write(chunk)
                            written += len(chunk)
                    if written > 0:
                        os.replace(part, dest)
                        ok = True
                        file_bytes = written
                        break
                    else:
                        try:
                            os.remove(part)
                        except OSError:
                            pass
                elif resp.status == 404:
                    resp.read()
                    is_404 = True
                    break
                else:
                    resp.read()
                break

            if ok or is_404:
                break
            reset_conn(cur_scheme, cur_host, cur_port)
        except Exception:
            reset_conn(scheme, host, port)
        time.sleep(0.35 * (attempt + 1))

    with lock:
        if ok:
            done_count += 1
            session_bytes += file_bytes
        elif is_404:
            missing_404 += 1
        else:
            failed_paths.append(rel)
        now = time.monotonic()
        processed = done_count + missing_404 + len(failed_paths)
        if processed == total or (now - last_print_ts) >= 0.4:
            last_print_ts = now
            elapsed = max(0.1, now - start_ts)
            speed = session_bytes / elapsed
            pct = (processed / max(1, total)) * 100.0
            remaining_files = max(0, total - processed)
            rate_files = (processed - (total - len(pending))) / elapsed if elapsed > 0 else 0
            eta = (remaining_files / rate_files) if rate_files > 0.05 else None
            line = (
                f"\\r[{done_count}/{total}] {pct:5.1f}% | "
                f"{fmt_size(session_bytes + already_bytes)} | "
                f"{fmt_size(speed)}/s | ETA {fmt_eta(eta)} | Falhas: {len(failed_paths)}   "
            )
            sys.stdout.write(line)
            sys.stdout.flush()

    return ok

if pending:
    with concurrent.futures.ThreadPoolExecutor(max_workers=MAX_WORKERS) as pool:
        list(pool.map(download_one, pending))
    print("")
else:
    print("Todos os arquivos ja estavam completos no cache!")

# 4) Descriptografar TODAS as tabelas d/* para JSON legivel em banco_de_dados_legivel/
print("")
print("[3/4] Descriptografando todas as tabelas do banco de dados (d/* -> banco_de_dados_legivel/)...")
d_dir = os.path.join(workdir, "d")
out_db_dir = os.path.join(workdir, "banco_de_dados_legivel")
os.makedirs(out_db_dir, exist_ok=True)

# 4a) Descobrir nomes originais (dados/*.json) escaneando todos os arquivos JS baixados em j/
slug_to_original = {}
for p in KNOWN_DADOS_PATHS:
    slug_to_original[slug_for(p)] = p

d_existing_slugs = set()
if os.path.isdir(d_dir):
    for fn in os.listdir(d_dir):
        if not fn.endswith(".part"):
            d_existing_slugs.add("d/" + fn)

j_dir = os.path.join(workdir, "j")
if os.path.isdir(j_dir) and d_existing_slugs:
    re_dados = re.compile(r"""["'\`](dados/[A-Za-z0-9_./-]+?\\.json)["'\`]""")
    re_json_name = re.compile(r"""["'\`]([A-Za-z0-9_/-]+\\.json)["'\`]""")
    prefixes = (
        "",
        "dados/",
        "dados/jogo/",
        "dados/tabelas/json/",
        "dados/tabelas/",
        "dados/telas/",
        "dados/ui/",
        "dados/plists/",
        "dados/csb/",
        "dados/mapas/",
    )
    for fn in os.listdir(j_dir):
        if not fn.endswith(".js"):
            continue
        try:
            with open(os.path.join(j_dir, fn), "r", encoding="utf-8", errors="ignore") as jf:
                txt = jf.read()
        except OSError:
            continue
        for match in re_dados.findall(txt):
            sl = slug_for(match)
            if sl in d_existing_slugs:
                slug_to_original[sl] = match
        for cand in set(re_json_name.findall(txt)):
            for pref in prefixes:
                full_p = pref + cand
                sl = slug_for(full_p)
                if sl in d_existing_slugs and sl not in slug_to_original:
                    slug_to_original[sl] = full_p
                    break

def sanitize_rel(raw_path):
    clean = raw_path.replace("\\\\", "/").lstrip("/")
    parts = [re.sub(r"[^A-Za-z0-9._-]", "_", part) for part in clean.split("/") if part and part not in (".", "..")]
    return "/".join(parts)

def save_decrypted_json(slug_rel, plain_bytes, index_list):
    slug_name = slug_rel.split("/", 1)[1]
    orig_path = slug_to_original.get(slug_rel)
    sample_keys = []
    inferred = orig_path or ""
    out_rel = ""

    parsed = None
    try:
        parsed = json.loads(plain_bytes.decode("utf-8"))
        if isinstance(parsed, dict):
            sample_keys = list(parsed.keys())[:8]
    except Exception:
        parsed = None

    if orig_path:
        out_rel = sanitize_rel(orig_path)
    elif isinstance(parsed, dict):
        if isinstance(parsed.get("arquivo"), str) and parsed["arquivo"].strip():
            inferred = parsed["arquivo"].strip()
            out_rel = "csb/" + sanitize_rel(inferred) + ".json"
        elif isinstance(parsed.get("plist"), str) and parsed["plist"].strip():
            inferred = parsed["plist"].strip()
            out_rel = "plists/" + sanitize_rel(inferred) + ".json"
        elif isinstance(parsed.get("nome"), str) and parsed["nome"].strip():
            inferred = parsed["nome"].strip()
            out_rel = "telas/" + sanitize_rel(inferred) + ".json"
        else:
            out_rel = f"tabelas_sem_nome/{slug_name}.json"
    else:
        out_rel = f"tabelas_sem_nome/{slug_name}.json"

    dest = os.path.join(out_db_dir, *out_rel.split("/"))
    if os.path.exists(dest) and not orig_path:
        stem, ext = os.path.splitext(dest)
        dest = f"{stem}_{slug_name[:6]}{ext}"
        out_rel = os.path.relpath(dest, out_db_dir).replace(os.sep, "/")

    os.makedirs(os.path.dirname(dest), exist_ok=True)
    with open(dest, "wb") as out_f:
        out_f.write(plain_bytes)

    index_list.append({
        "slug": slug_rel,
        "origem": inferred or None,
        "arquivo": "banco_de_dados_legivel/" + out_rel,
        "bytes": len(plain_bytes),
        "chaves": sample_keys,
    })

decrypted_count = 0
decrypt_errors = 0
db_index = []

aesgcm_mod = None
try:
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    aesgcm_mod = AESGCM(DADOS_KEY)
except Exception:
    aesgcm_mod = None

if aesgcm_mod is not None and os.path.isdir(d_dir):
    all_d_files = sorted(fn for fn in os.listdir(d_dir) if not fn.endswith(".part"))
    for idx, fn in enumerate(all_d_files, 1):
        full = os.path.join(d_dir, fn)
        try:
            with open(full, "rb") as f:
                raw = f.read()
            if len(raw) < 29:
                decrypt_errors += 1
                continue
            plain_gz = aesgcm_mod.decrypt(raw[:12], raw[12:], None)
            plain_bytes = gzip.decompress(plain_gz)
            save_decrypted_json("d/" + fn, plain_bytes, db_index)
            decrypted_count += 1
        except Exception:
            decrypt_errors += 1
        if idx == len(all_d_files) or idx % 200 == 0:
            sys.stdout.write(f"\\rDescriptografando tabelas: [{idx}/{len(all_d_files)}]   ")
            sys.stdout.flush()
    print("")
elif shutil.which("node") and os.path.isdir(d_dir):
    print("Usando Node.js para descriptografar todas as tabelas d/*...")
    map_path = os.path.join(workdir, "_slug_map.json")
    with open(map_path, "w", encoding="utf-8") as mf:
        json.dump(slug_to_original, mf)
    node_script = (
        "const fs=require('fs'),path=require('path'),crypto=require('crypto'),zlib=require('zlib');"
        "const dDir=process.argv[2],outDir=process.argv[3],mapFile=process.argv[4];"
        "const dd=[235,20,121,179,169,214,12,110,45,124,15,69,195,69,143,13,204,127,129,82,250,177,75,193,124,73,91,82,105,59,253,150];"
        "const cd=[92,22,12,90,34,94,181,210,180,198,202,239,190,191,222,194,149,192,96,172,240,122,214,100,72,35,236,168,219,160,20,175];"
        "const master=Buffer.from(dd.map((v,i)=>v^cd[i]));"
        "const key=crypto.createHmac('sha256',master).update('dados').digest();"
        "const slugMap=JSON.parse(fs.readFileSync(mapFile,'utf8'));"
        "const san=s=>s.replace(/\\\\\\\\/g,'/').replace(/^\\/+/, '').split('/').filter(p=>p&&p!=='.'&&p!=='..').map(p=>p.replace(/[^A-Za-z0-9._-]/g,'_')).join('/');"
        "const idx=[];let ok=0,err=0;"
        "for(const fn of fs.readdirSync(dDir).sort()){"
        "  if(fn.endsWith('.part')) continue;"
        "  try{"
        "    const buf=fs.readFileSync(path.join(dDir,fn));"
        "    const dec=crypto.createDecipheriv('aes-256-gcm',key,buf.subarray(0,12));"
        "    dec.setAuthTag(buf.subarray(buf.length-16));"
        "    const plain=zlib.gunzipSync(Buffer.concat([dec.update(buf.subarray(12,buf.length-16)),dec.final()]));"
        "    const sl='d/'+fn; const orig=slugMap[sl]; let obj=null; let keys=[];"
        "    try{obj=JSON.parse(plain.toString('utf8')); if(obj&&typeof obj==='object'&&!Array.isArray(obj)) keys=Object.keys(obj).slice(0,8);}catch{}"
        "    let outRel='',inf=orig||'';"
        "    if(orig) outRel=san(orig);"
        "    else if(obj&&typeof obj.arquivo==='string'&&obj.arquivo.trim()){inf=obj.arquivo.trim();outRel='csb/'+san(inf)+'.json';}"
        "    else if(obj&&typeof obj.plist==='string'&&obj.plist.trim()){inf=obj.plist.trim();outRel='plists/'+san(inf)+'.json';}"
        "    else if(obj&&typeof obj.nome==='string'&&obj.nome.trim()){inf=obj.nome.trim();outRel='telas/'+san(inf)+'.json';}"
        "    else outRel='tabelas_sem_nome/'+fn+'.json';"
        "    let dest=path.join(outDir,...outRel.split('/'));"
        "    if(fs.existsSync(dest)&&!orig){const e=path.extname(dest);dest=dest.slice(0,-e.length)+'_'+fn.slice(0,6)+e;outRel=path.relative(outDir,dest).split(path.sep).join('/');}"
        "    fs.mkdirSync(path.dirname(dest),{recursive:true}); fs.writeFileSync(dest,plain);"
        "    idx.push({slug:sl,origem:inf||null,arquivo:'banco_de_dados_legivel/'+outRel,bytes:plain.length,chaves:keys}); ok++;"
        "  }catch{err++;}"
        "}"
        "fs.writeFileSync(path.join(outDir,'_indice_tabelas.json'),JSON.stringify({total:idx.length,erros:err,tabelas:idx},null,2));"
        "console.log('NODE_DECRYPT_OK '+ok+' '+err);"
    )
    res = subprocess.run(["node", "-e", node_script, d_dir, out_db_dir, map_path], capture_output=True, text=True)
    try:
        os.remove(map_path)
    except OSError:
        pass
    if res.returncode == 0 and "NODE_DECRYPT_OK" in res.stdout:
        parts = res.stdout.strip().split()
        decrypted_count = int(parts[-2])
        decrypt_errors = int(parts[-1])
    else:
        print("[Aviso] Falha na descriptografia via Node:", res.stderr.strip()[:200])
else:
    print("[Aviso] Nem 'python-cryptography' nem 'node' estao instalados.")
    print("        Os arquivos brutos d/* foram baixados intactos.")
    print("        No Termux, rode: pkg install -y python-cryptography  e execute o script novamente.")

if db_index:
    with open(os.path.join(out_db_dir, "_indice_tabelas.json"), "w", encoding="utf-8") as idxf:
        json.dump(
            {
                "geradoEm": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                "origem": origin,
                "dadosVersao": dados_versao,
                "totalDescriptografadas": decrypted_count,
                "nomesOriginaisRecuperados": len(slug_to_original),
                "erros": decrypt_errors,
                "tabelas": db_index,
            },
            idxf,
            ensure_ascii=False,
            indent=2,
        )

print(f"Tabelas descriptografadas: {decrypted_count} (nomes originais mapeados: {len(slug_to_original)}, erros: {decrypt_errors})")

# Gravar guia de estrutura dentro do backup
readme_text = f"""Shinobi Sprite Studio - Copia Completa do Jogo & Banco de Dados
================================================================
Origem: {origin}
Escopo: {scope}
Versao dos dados: {dados_versao}
Arquivos baixados: {done_count} / {total}
Tabelas JSON descriptografadas: {decrypted_count}

ESTRUTURA DE PASTAS:
- banco_de_dados_legivel/   -> Todas as 3.215 tabelas d/* descriptografadas em JSON puro!
    - dados/jogo/           -> herois.json, skills.json, pt.json (traducoes), sons.json, itens.json, campanha.json...
    - dados/tabelas/json/   -> RoleModel.json, SkinConfig.json, FighterConfigForBattle.json, ConfigValue.json...
    - csb/ & telas/         -> Layouts de telas e interfaces do jogo em JSON
    - plists/               -> Atlas/plists de texturas de UI
    - _indice_tabelas.json  -> Indice completo ligando cada d/<slug> ao JSON legivel
- _shinobi_backup/          -> Catalogo estruturado + combate_e_habilidades.json (compativel com Abrir ZIP local)
- d/                        -> Tabelas originais criptografadas (exatamente como no servidor)
- j/ e lib/                 -> Codigo cliente JS/CSS + bibliotecas Phaser e Spine WebGL
- jogar.html & recursos-manifesto.json -> Pagina e manifesto completo de arquivos
- acervo/ e vila/           -> Todos os sprites Spine, particulas, retratos, mapas vivos, UI, itens, videos MP4 e audios MP3
"""
with open(os.path.join(workdir, "LEIA-ME_ESTRUTURA.txt"), "w", encoding="utf-8") as rf:
    rf.write(readme_text)

# 5) Empacotar em 1 UNICO arquivo ZIP64 STORE (ou finalizar em modo pasta)
if not pack_zip:
    print("")
    print("============================================================")
    print("  PRONTO! COPIA COMPLETA SALVA EM PASTA!")
    print(f"  Pasta:   {workdir}")
    print(f"  Tabelas: {decrypted_count} JSONs legiveis em banco_de_dados_legivel/")
    print("============================================================")
    sys.exit(0)

print("")
print(f"[4/4] Empacotando tudo em 1 UNICO arquivo ZIP64 STORE: {zipout}")
os.makedirs(os.path.dirname(os.path.abspath(zipout)), exist_ok=True)
tmp_zip = (zipout[:-4] + ".tmp.zip") if zipout.lower().endswith(".zip") else (zipout + ".tmp.zip")
if os.path.exists(tmp_zip):
    os.remove(tmp_zip)

files_to_pack = []
for dirpath, _, filenames in os.walk(workdir):
    for fn in filenames:
        if fn.endswith(".part"):
            continue
        full = os.path.join(dirpath, fn)
        arc = os.path.relpath(full, workdir).replace(os.sep, "/")
        files_to_pack.append((full, arc))

files_to_pack.sort(key=lambda item: (0 if item[1].startswith("_shinobi_backup/") else 1, item[1]))
pack_total = len(files_to_pack)
pack_start = time.monotonic()

with zipfile.ZipFile(tmp_zip, "w", compression=zipfile.ZIP_STORED, allowZip64=True) as zf:
    zf.comment = ARCHIVE_COMMENT
    for idx, (full, arc) in enumerate(files_to_pack, 1):
        zf.write(full, arc)
        if idx == pack_total or idx % 300 == 0:
            pct = (idx / max(1, pack_total)) * 100.0
            sys.stdout.write(f"\\rEmpacotando: [{idx}/{pack_total}] {pct:5.1f}%   ")
            sys.stdout.flush()

os.replace(tmp_zip, zipout)
final_size = os.path.getsize(zipout)
print("")
print(f"Empacotamento concluido em {time.monotonic() - pack_start:.1f}s ({fmt_size(final_size)}).")

if len(failed_paths) == 0:
    print("Limpando cache temporario para liberar espaco no dispositivo...")
    shutil.rmtree(workdir, ignore_errors=True)
    print("")
    print("============================================================")
    print("  PRONTO! COPIA COMPLETA CONCLUIDA EM 1 UNICO ARQUIVO!")
    print(f"  Salvo em: {zipout}")
    print(f"  Tamanho:  {fmt_size(final_size)} ({pack_total} arquivos)")
    print(f"  Banco DB: {decrypted_count} tabelas JSON em banco_de_dados_legivel/")
    print("============================================================")
else:
    print("")
    print(f"AVISO: {len(failed_paths)} arquivo(s) falharam durante o download.")
    print(f"ZIP parcial salvo em: {zipout}")
    print("O cache foi mantido. Execute o script novamente para retomar apenas o que faltou.")
PY_MIRROR

if [ "$IS_TERMUX" -eq 1 ]; then
  if [ -f "$ZIPOUT" ]; then
    command -v termux-media-scan >/dev/null 2>&1 && termux-media-scan "$ZIPOUT" >/dev/null 2>&1 || true
  fi
  command -v termux-wake-unlock >/dev/null 2>&1 && termux-wake-unlock || true
fi
`;

  triggerTextFileDownload(sh, scriptFilename, 'text/x-shellscript;charset=utf-8');
  return scriptFilename;
}

/**
 * Generates a self-updating 16-thread Windows PowerShell script (.ps1) that fetches the live
 * `recursos-manifesto.*.json`, downloads all game files (`all_files` or `database_only`) with
 * exact byte-size resume, automatically decrypts all 3,215 `d/*` database tables via Node.js
 * (or Python cryptography if present), and packages everything into 1 single ZIP64 STORE file.
 */
export function downloadFullGameMirrorWindowsScript(spec: FullGameMirrorSpec): string {
  const originClean = spec.origin.replace(/\/+$/, '');
  const isAll = spec.scope === 'all_files';
  const baseName = isAll ? 'shinobi_jogo_completo_tudo' : 'shinobi_banco_de_dados_completo';
  const zipName = `${baseName}.zip`;
  const scriptFilename = isAll
    ? 'baixar_jogo_completo_tudo.ps1'
    : 'baixar_banco_de_dados_completo.ps1';
  const label = isAll
    ? 'Copia Completa do Jogo — 100% de Todos os Arquivos (~81.000+ arquivos, ~13 GB)'
    : 'Banco de Dados Completo + Codigo Cliente (3.215 tabelas JSON + JS/CSS + Libs)';

  const metaArchiveBlock = spec.metaArchiveBase64
    ? `$MetaZipB64 = @'
${wrapBase64(spec.metaArchiveBase64)}
'@
$MetaZipPath = Join-Path $WorkDir '_meta_pack.zip'
[IO.File]::WriteAllBytes($MetaZipPath, [Convert]::FromBase64String(($MetaZipB64 -replace '\\s+', '')))
Add-Type -AssemblyName System.IO.Compression.FileSystem
$MetaArchive = [System.IO.Compression.ZipFile]::OpenRead($MetaZipPath)
try {
  foreach ($entry in $MetaArchive.Entries) {
    if ([string]::IsNullOrEmpty($entry.Name)) { continue }
    $destPath = Join-Path $WorkDir ($entry.FullName -replace '/', '\\')
    $destDir = Split-Path -Parent $destPath
    if (-not (Test-Path $destDir)) { New-Item -ItemType Directory -Force -Path $destDir | Out-Null }
    [System.IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $destPath, $true)
  }
} finally {
  $MetaArchive.Dispose()
  Remove-Item -Force $MetaZipPath -ErrorAction SilentlyContinue
}`
    : '';

  const ps1 = `# Shinobi Sprite Studio - Extrator Completo do Jogo & Banco de Dados (Windows PowerShell)
# Modo: ${label}
# Como usar: Clique com o botao direito -> "Executar com o PowerShell"
# Retomavel: se a internet cair, execute novamente para continuar exatamente de onde parou!

$ErrorActionPreference = 'Continue'
$Origin = '${originClean.replace(/'/g, "''")}'
$Scope = '${spec.scope}'
$WorkDir = Join-Path $PSScriptRoot '.shinobi_cache_${baseName}'
$ZipOut = Join-Path $PSScriptRoot '${zipName}'

New-Item -ItemType Directory -Force -Path $WorkDir | Out-Null
Write-Host "============================================================" -ForegroundColor DarkCyan
Write-Host "  ${label}" -ForegroundColor Cyan
Write-Host "  Origem: $Origin (16 conexoes paralelas, sem CORS)" -ForegroundColor Gray
Write-Host "============================================================" -ForegroundColor DarkCyan

Write-Host "[1/4] Buscando manifesto oficial ao vivo (/jogar?app=1)..." -ForegroundColor Cyan
$Headers = @{ 'User-Agent' = 'Mozilla/5.0 ShinobiMirror/2.0'; 'Referer' = "$Origin/" }
$Html = (Invoke-WebRequest -UseBasicParsing -Headers $Headers -Uri "$Origin/jogar?app=1").Content
Set-Content -Encoding UTF8 -Path (Join-Path $WorkDir 'jogar.html') -Value $Html

if ($Html -notmatch 'window\\.__VDF_RECURSOS__\\s*=\\s*(\\{[^}]*\\})') {
  Write-Host "Erro: nao foi possivel encontrar __VDF_RECURSOS__." -ForegroundColor Red
  Pause
  exit 1
}
$Rec = $Matches[1] | ConvertFrom-Json
$ManUrl = "$Origin/$($Rec.manifesto.TrimStart('/'))"
$ManRaw = (Invoke-WebRequest -UseBasicParsing -Headers $Headers -Uri $ManUrl).Content
Set-Content -Encoding UTF8 -Path (Join-Path $WorkDir 'recursos-manifesto.json') -Value $ManRaw
$Man = $ManRaw | ConvertFrom-Json
$DadosVersao = if ($Man.dadosVersao) { [string]$Man.dadosVersao } else { '0' }

if ($Rec.partes) {
  try {
    $PartesRaw = (Invoke-WebRequest -UseBasicParsing -Headers $Headers -Uri "$Origin/$($Rec.partes.TrimStart('/'))").Content
    Set-Content -Encoding UTF8 -Path (Join-Path $WorkDir 'recursos-indice.json') -Value $PartesRaw
  } catch {}
}

$Items = New-Object System.Collections.Generic.List[object]
$Seen = New-Object 'System.Collections.Generic.HashSet[string]'
foreach ($prop in $Man.arquivos.PSObject.Properties) {
  $entry = $prop.Value
  $rel = [string]$entry.url
  if (-not $rel) { continue }
  $rel = $rel.TrimStart('/')
  if ($Scope -eq 'database_only') {
    if (-not ($rel.StartsWith('d/') -or $rel.StartsWith('j/') -or $rel.StartsWith('lib/') -or $rel -eq 'acervo/asset/spine-hd/indice.json' -or $rel -eq 'acervo/asset/spine-astc/lista.json')) {
      continue
    }
  }
  if ($Seen.Add($rel)) {
    $Items.Add([pscustomobject]@{ Rel = $rel; Bytes = [int64]($entry.bytes) })
  }
}

$Done = 0
$Total = $Items.Count
$Pending = New-Object System.Collections.Generic.List[object]
foreach ($it in $Items) {
  $dest = Join-Path $WorkDir ($it.Rel -replace '/', '\\')
  if ((Test-Path $dest) -and ((Get-Item $dest).Length -gt 0) -and (($it.Bytes -le 0) -or ((Get-Item $dest).Length -eq $it.Bytes))) {
    $Done++
  } else {
    $Pending.Add($it)
  }
}

Write-Host "[2/4] Total: $Total arquivos | Em cache: $Done | Faltam baixar: $($Pending.Count)" -ForegroundColor Yellow

$MaxJobs = 16
$Pool = [runspacefactory]::CreateRunspacePool(1, $MaxJobs)
$Pool.Open()
$Jobs = New-Object System.Collections.ArrayList

$ScriptBlock = {
  param($OriginUrl, $RelPath, $OutRoot, $DadosVer)
  $url = if ($RelPath.StartsWith('d/')) { "$OriginUrl/$RelPath?v=$DadosVer" } else { "$OriginUrl/$RelPath" }
  $dest = Join-Path $OutRoot ($RelPath -replace '/', '\\')
  $dir = Split-Path -Parent $dest
  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
  $part = "$dest.part"
  for ($try = 1; $try -le 4; $try++) {
    try {
      & curl.exe -fSL --retry 2 --connect-timeout 15 --max-time 180 -C - -o $part $url 2>$null
      if ((Test-Path $part) -and ((Get-Item $part).Length -gt 0)) {
        Move-Item -Force $part $dest
        return $true
      }
    } catch {}
    Start-Sleep -Milliseconds (400 * $try)
  }
  return $false
}

foreach ($it in $Pending) {
  $ps = [powershell]::Create().AddScript($ScriptBlock).AddArgument($Origin).AddArgument($it.Rel).AddArgument($WorkDir).AddArgument($DadosVersao)
  $ps.RunspacePool = $Pool
  [void]$Jobs.Add([pscustomobject]@{ Pipe = $ps; Handle = $ps.BeginInvoke() })
}

$Failed = 0
foreach ($job in $Jobs) {
  $ok = $job.Pipe.EndInvoke($job.Handle)
  $job.Pipe.Dispose()
  if ($ok) { $Done++ } else { $Failed++ }
  if (($Done % 25 -eq 0) -or ($Done + $Failed -eq $Total)) {
    $pct = [math]::Round((($Done + $Failed) / [math]::Max(1, $Total)) * 100)
    Write-Progress -Activity "Baixando ${baseName}" -Status "$Done / $Total concluido(s) ($Failed falhas)" -PercentComplete $pct
  }
}
$Pool.Close()
$Pool.Dispose()

${metaArchiveBlock}

Write-Host "[3/4] Descriptografando tabelas d/* para banco_de_dados_legivel/..." -ForegroundColor Cyan
$NodeCmd = Get-Command node -ErrorAction SilentlyContinue
if ($NodeCmd) {
  $DecryptJs = @'
const fs=require('fs'),path=require('path'),crypto=require('crypto'),zlib=require('zlib');
const root=process.argv[2];
const dDir=path.join(root,'d'),jDir=path.join(root,'j'),outDir=path.join(root,'banco_de_dados_legivel');
fs.mkdirSync(outDir,{recursive:true});
const dd=[235,20,121,179,169,214,12,110,45,124,15,69,195,69,143,13,204,127,129,82,250,177,75,193,124,73,91,82,105,59,253,150];
const cd=[92,22,12,90,34,94,181,210,180,198,202,239,190,191,222,194,149,192,96,172,240,122,214,100,72,35,236,168,219,160,20,175];
const master=Buffer.from(dd.map((v,i)=>v^cd[i]));
const nomeKey=crypto.createHmac('sha256',master).update('nome').digest();
const dadosKey=crypto.createHmac('sha256',master).update('dados').digest();
const slugFor=p=>'d/'+crypto.createHmac('sha256',nomeKey).update(p).digest().subarray(0,16).toString('base64').replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,'');
const known=['dados/jogo/herois.json','dados/jogo/skills.json','dados/jogo/pt.json','dados/jogo/sons.json','dados/jogo/itens.json','dados/jogo/campanha.json','dados/jogo/clipes.json','dados/tabelas/json/RoleModel.json','dados/tabelas/json/SkinConfig.json','dados/tabelas/json/ConfigValue.json','dados/tabelas/json/FighterConfigForBattle.json'];
const dSet=new Set(fs.existsSync(dDir)?fs.readdirSync(dDir).filter(f=>!f.endsWith('.part')).map(f=>'d/'+f):[]);
const slugMap={};
for(const p of known){slugMap[slugFor(p)]=p;}
if(fs.existsSync(jDir)){
  const prefs=['','dados/','dados/jogo/','dados/tabelas/json/','dados/tabelas/','dados/telas/','dados/ui/'];
  for(const fn of fs.readdirSync(jDir)){
    if(!fn.endsWith('.js')) continue;
    const txt=fs.readFileSync(path.join(jDir,fn),'utf8');
    for(const m of txt.matchAll(/["'\`](dados\\/[A-Za-z0-9_.\\/-]+?\\.json)["'\`]/g)){const s=slugFor(m[1]);if(dSet.has(s))slugMap[s]=m[1];}
    for(const m of txt.matchAll(/["'\`]([A-Za-z0-9_\\/-]+\\.json)["'\`]/g)){for(const pr of prefs){const fp=pr+m[1];const s=slugFor(fp);if(dSet.has(s)&&!slugMap[s]){slugMap[s]=fp;break;}}}
  }
}
const san=s=>s.replace(/\\\\/g,'/').replace(/^\\/+/, '').split('/').filter(p=>p&&p!=='.'&&p!=='..').map(p=>p.replace(/[^A-Za-z0-9._-]/g,'_')).join('/');
const idx=[];let ok=0,err=0;
if(fs.existsSync(dDir)){
  for(const fn of fs.readdirSync(dDir).sort()){
    if(fn.endsWith('.part')) continue;
    try{
      const buf=fs.readFileSync(path.join(dDir,fn));
      const dec=crypto.createDecipheriv('aes-256-gcm',dadosKey,buf.subarray(0,12));
      dec.setAuthTag(buf.subarray(buf.length-16));
      const plain=zlib.gunzipSync(Buffer.concat([dec.update(buf.subarray(12,buf.length-16)),dec.final()]));
      const sl='d/'+fn;const orig=slugMap[sl];let obj=null;let keys=[];
      try{obj=JSON.parse(plain.toString('utf8'));if(obj&&typeof obj==='object'&&!Array.isArray(obj))keys=Object.keys(obj).slice(0,8);}catch{}
      let outRel='',inf=orig||'';
      if(orig) outRel=san(orig);
      else if(obj&&typeof obj.arquivo==='string'&&obj.arquivo.trim()){inf=obj.arquivo.trim();outRel='csb/'+san(inf)+'.json';}
      else if(obj&&typeof obj.plist==='string'&&obj.plist.trim()){inf=obj.plist.trim();outRel='plists/'+san(inf)+'.json';}
      else if(obj&&typeof obj.nome==='string'&&obj.nome.trim()){inf=obj.nome.trim();outRel='telas/'+san(inf)+'.json';}
      else outRel='tabelas_sem_nome/'+fn+'.json';
      let dest=path.join(outDir,...outRel.split('/'));
      if(fs.existsSync(dest)&&!orig){const e=path.extname(dest);dest=dest.slice(0,-e.length)+'_'+fn.slice(0,6)+e;outRel=path.relative(outDir,dest).split(path.sep).join('/');}
      fs.mkdirSync(path.dirname(dest),{recursive:true});fs.writeFileSync(dest,plain);
      idx.push({slug:sl,origem:inf||null,arquivo:'banco_de_dados_legivel/'+outRel,bytes:plain.length,chaves:keys});ok++;
    }catch{err++;}
  }
}
fs.writeFileSync(path.join(outDir,'_indice_tabelas.json'),JSON.stringify({totalDescriptografadas:ok,nomesOriginaisRecuperados:Object.keys(slugMap).length,erros:err,tabelas:idx},null,2));
console.log('Descriptografadas: '+ok+' tabelas JSON (nomes recuperados: '+Object.keys(slugMap).length+', erros: '+err+')');
'@
  $DecryptFile = Join-Path $WorkDir '_decrypt_db.cjs'
  Set-Content -Encoding UTF8 -Path $DecryptFile -Value $DecryptJs
  & node $DecryptFile $WorkDir
  Remove-Item -Force $DecryptFile -ErrorAction SilentlyContinue
} else {
  Write-Host "[Aviso] Node.js nao encontrado no Windows. Os arquivos d/* foram salvos brutos." -ForegroundColor Yellow
  Write-Host "        Instale Node.js (nodejs.org) e rode novamente para descriptografar d/* em JSON." -ForegroundColor Yellow
}

Write-Host "[4/4] Empacotando arquivo unico $ZipOut em modo STORE..." -ForegroundColor Cyan
if (Test-Path $ZipOut) { Remove-Item -Force $ZipOut }
Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::CreateFromDirectory($WorkDir, $ZipOut, [System.IO.Compression.CompressionLevel]::NoCompression, $false)

if ($Failed -eq 0) {
  Remove-Item -Recurse -Force $WorkDir -ErrorAction SilentlyContinue
  Write-Host "PRONTO! Copia completa salva em: $ZipOut ($Done/$Total arquivos)." -ForegroundColor Green
} else {
  Write-Host "ZIP parcial gerado em $ZipOut ($Done/$Total). $Failed falha(s). Execute novamente para retomar." -ForegroundColor Yellow
}
Pause
`;

  triggerTextFileDownload(ps1, scriptFilename);
  return scriptFilename;
}


