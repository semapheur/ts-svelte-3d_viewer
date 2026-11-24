param(
  [string]$Root = $PSScriptRoot,
  [int]$Port = 8080
)

function Get-AvailablePort($startPort) {
  $port = $startPort
  while ($true) {
    $tcp = Test-NetConnection -ComputerName 'localhost' -Port $port -WarningAction SilentlyContinue
    if (-not $tcp.TcpTestSucceeded) {
      return $port
    }
    $port++
  }
}

function Get-ContentType($filePath) {
  switch -regex ([IO.Path]::GetExtension($filePath).ToLower()) {
    '^\.html?$'  { return "text/html; charset=utf-8" }
    '^\.m?js$'   { return "text/javascript" }
    '^\.css$'    { return "text/css" }
    '^\.json$'   { return "application/json" }
    '^\.wasm$'   { return "application/wasm" }
    '^\.png$'    { return "image/png" }
    '^\.jpe?g$'  { return "image/jpeg" }
    '^\.gif$'    { return "image/gif" }
    '^\.svg$'    { return "image/svg+xml" }
    '^\.ico$'    { return "image/x-icon" }
    '^\.glb$'    { return "model/gltf-binary" }
    '^\.gltf$'   { return "model/gltf+json" }
    '^\.woff2$'  { return "font/woff2" }
    default      { return "application/octet-stream" }
  }
}

$resolvedRoot = [IO.Path]::GetFullPath($Root)
$sep = [IO.Path]::DirectorySeparatorChar
$rootPrefix = $resolvedRoot.TrimEnd('\', '/') + $sep

$Port = Get-AvailablePort -startPort $Port
$url = "http://localhost:$Port/"

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add($url)

try {
  $listener.Start()
  Write-Host "Serving '$resolvedRoot' at $url"
  Write-Host "Press Ctrl+C to stop server"

  Start-Process $url | Out-Null

  while ($listener.IsListening) {
    $context = $null
    try {
      $context = $listener.GetContext()
      if (-not $context) { continue }

      $request = $context.Request
      $response = $context.Response

      $response.Headers["Cross-Origin-Opener-Policy"] = "same-origin"
      $response.Headers["Cross-Origin-Embedder-Policy"] = "require-corp"

      if (-not $request.Url) {
        $response.StatusCode = 400
        continue
      }

      $relativePath = ($request.Url.LocalPath -replace '^[\\/]+', '') -replace '/', $sep
      if ([string]::IsNullOrWhiteSpace($relativePath)) {
        $relativePath = "index.html"
      }

      $candidatePath = [IO.Path]::GetFullPath((Join-Path $rootPrefix $relativePath))

      # Prevent directory traversal (including sibling folder prefix collisions)
      if (-not $candidatePath.StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase)) {
        $response.StatusCode = 403
        continue
      }

      if (-not (Test-Path -LiteralPath $candidatePath -PathType Leaf)) {
        $response.StatusCode = 404
        continue
      }

      # Resolve symlinks/reparse points and re-verify boundary
      $realPath = (Resolve-Path -LiteralPath $candidatePath).Path
      if (-not $realPath.StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase)) {
        $response.StatusCode = 403
        continue
      }

      $bytes = [System.IO.File]::ReadAllBytes($realPath)
      $response.StatusCode = 200
      $response.ContentType = Get-ContentType $realPath
      $response.ContentLength64 = $bytes.Length
      $response.OutputStream.Write($bytes, 0, $bytes.Length)
    } catch [System.Net.HttpListenerException] {
      if ($listener.IsListening) {
        Write-Host "Listener error: $_"
      }
    } catch {
      Write-Host "Error handling request: $_"
      if ($context -and $context.Response) {
        try { $context.Response.StatusCode = 500 } catch {}
      }
    } finally {
      if ($context -and $context.Response) {
        try { $context.Response.OutputStream.Close() } catch {}
        try { $context.Response.Close() } catch {}
      }
    }
  }
} catch {
  Write-Error "Failed to start or run listener: $_"
  exit 1
} finally {
  if ($listener) {
    $listener.Stop()
    $listener.Close()
  }
}
