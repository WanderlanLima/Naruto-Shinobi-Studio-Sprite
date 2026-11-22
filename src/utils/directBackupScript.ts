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
 * Exports a resumable, 8-thread PowerShell script (.ps1) for Windows that downloads all files
 * directly from the origin (bypassing browser CORS completely) and packs them into an exact
 * STORE-mode .zip ready to import into the "Backup Offline" tab.
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

  const ps1 = `# Shinobi Sprite Studio - Download Direto em Alta Velocidade (Sem Proxy / Retomavel)
# Modulo: ${spec.label}
# Arquivos: ${spec.paths.length}
# Como usar no Windows: Clique com o botao direito -> "Executar com o PowerShell"
# Se cair a internet, basta executar novamente: ele continua exatamente de onde parou!

$ErrorActionPreference = 'Continue'
$Origin = '${originClean.replace(/'/g, "''")}'
$WorkDir = Join-Path $PSScriptRoot '${base}_tmp'
$ZipOut = Join-Path $PSScriptRoot '${zipName.replace(/'/g, "''")}'

$Paths = @'
${safePaths}
'@ -split "\`r?\`n" | Where-Object { $_.Trim() -ne '' }

New-Item -ItemType Directory -Force -Path $WorkDir | Out-Null
Write-Host "Iniciando download direto de $($Paths.Count) arquivos (retomavel, sem CORS)..." -ForegroundColor Cyan

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

$MaxJobs = 8
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
      & curl.exe -fSL --retry 2 --connect-timeout 15 -C - -o $part $url 2>$null
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
  if (($Done % 10 -eq 0) -or ($Done + $Failed -eq $Total)) {
    $pct = [math]::Round((($Done + $Failed) / [math]::Max(1, $Total)) * 100)
    Write-Progress -Activity "Baixando ${base}" -Status "$Done / $Total concluido(s) ($Failed falhas)" -PercentComplete $pct
  }
}
$Pool.Close()
$Pool.Dispose()

$MetaDir = Join-Path $WorkDir '_shinobi_backup'
New-Item -ItemType Directory -Force -Path $MetaDir | Out-Null
@'
${metaJson}
'@ | Set-Content -Encoding UTF8 (Join-Path $MetaDir 'meta.json')

Write-Host "Empacotando $ZipOut em modo STORE (leitura instantanea no app)..." -ForegroundColor Cyan
if (Test-Path $ZipOut) { Remove-Item -Force $ZipOut }
Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::CreateFromDirectory($WorkDir, $ZipOut, [System.IO.Compression.CompressionLevel]::NoCompression, $false)

Write-Host "Pronto! Arquivo gerado: $ZipOut ($Done/$Total arquivos)." -ForegroundColor Green
Write-Host "Agora abra esse .zip na aba 'Backup Offline' do Shinobi Sprite Studio!" -ForegroundColor Green
if ($Failed -gt 0) {
  Write-Host "Aviso: $Failed arquivos falharam. Execute este script novamente para retomar apenas os que faltam." -ForegroundColor Yellow
}
Pause
`;

  triggerTextFileDownload(ps1, `baixar_${base}.ps1`);
}

/**
 * Exports a resumable, 8-thread Bash script (.sh) for Android Termux, Linux, and macOS.
 * Downloads directly from the origin with curl -C - (resume support) and builds the exact STORE ZIP.
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

  const sh = `#!/usr/bin/env bash
# Shinobi Sprite Studio - Download Direto em Alta Velocidade (Sem Proxy / Retomavel)
# Compativel com Android (Termux), Linux e macOS
# Modulo: ${spec.label} (${spec.paths.length} arquivos)
# Como usar: bash baixar_${base}.sh
# Se interrompido, execute novamente para continuar exatamente de onde parou!

set -u
ORIGIN="${originClean}"
WORKDIR="./${base}_tmp"
ZIPOUT="./${zipName}"
LISTFILE="$WORKDIR/_paths.txt"

mkdir -p "$WORKDIR/_shinobi_backup"
cat <<'EOF_META' > "$WORKDIR/_shinobi_backup/meta.json"
${metaJson}
EOF_META

cat <<'EOF_PATHS' > "$LISTFILE"
${safePaths}
EOF_PATHS

TOTAL=$(wc -l < "$LISTFILE" | tr -d ' ')
echo "Baixando $TOTAL arquivos diretamente de $ORIGIN (8 conexoes paralelas, retomavel)..."

download_one() {
  local rel="$1"
  local dest="$WORKDIR/$rel"
  if [ -s "$dest" ]; then
    return 0
  fi
  mkdir -p "$(dirname "$dest")"
  local part="$dest.part"
  if curl -fSL --retry 3 --connect-timeout 15 -C - -o "$part" "$ORIGIN/$rel" 2>/dev/null && [ -s "$part" ]; then
    mv -f "$part" "$dest"
    echo "[OK] $rel"
  else
    echo "[FALHA] $rel" >&2
  fi
}

export ORIGIN WORKDIR
export -f download_one

xargs -P 8 -I {} bash -c 'download_one "$@"' _ {} < "$LISTFILE"
rm -f "$LISTFILE"

echo "Montando $ZIPOUT em modo STORE (leitura instantanea no app)..."
rm -f "$ZIPOUT"
if command -v zip >/dev/null 2>&1; then
  (cd "$WORKDIR" && zip -0 -r -q "../${zipName}" .)
elif command -v python3 >/dev/null 2>&1; then
  python3 - "$WORKDIR" "$ZIPOUT" <<'PY'
import os, sys, zipfile
root, out = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(out, 'w', compression=zipfile.ZIP_STORED, allowZip64=True) as zf:
    for dirpath, _, filenames in os.walk(root):
        for fn in filenames:
            if fn.endswith('.part'):
                continue
            full = os.path.join(dirpath, fn)
            arc = os.path.relpath(full, root).replace(os.sep, '/')
            zf.write(full, arc)
PY
else
  echo "Instale 'zip' ou 'python3' (no Termux: pkg install zip) e rode novamente para empacotar."
  exit 1
fi

echo "Concluido! Abra $ZIPOUT na aba 'Backup Offline' do Shinobi Sprite Studio."
`;

  triggerTextFileDownload(sh, `baixar_${base}.sh`, 'text/x-shellscript;charset=utf-8');
}
