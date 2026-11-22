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
tmp_zip = zipout + ".building"
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
  command -v termux-wake-unlock >/dev/null 2>&1 && termux-wake-unlock || true
fi
`;

  triggerTextFileDownload(sh, `baixar_${base}.sh`, 'text/x-shellscript;charset=utf-8');
}

