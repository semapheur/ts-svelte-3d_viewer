param(
  [string]$Root = ".\dist",
  [int]$Port = 8080
)

$rootFull = (Resolve-Path $Root).Path.TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar

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

$url = "http://localhost:$Port/"
$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add($url)

try {
  $listener.Start()
  Write-Host "Serving '$Root' at $url"
  Write-Host "Press Ctrl+C to stop server"

  Start-Process $url
} catch {
  Write-Error "Failed to start listener"
  pause
  exit 1
}

while ($true) {
  try {
    $context = $listener.GetContext()
    if (-not $context) { continue }

    $request = $context.Request
    $response = $context.Response
    $response.Headers.Add("Cross-Origin-Opener-Policy", "same-origin")
    $response.Headers.Add("Cross-Origin-Embedder-Policy", "require-corp")

    if (-not $request.Url) {
      $response.StatusCode = 404
      $response.OutputStream.Close()
      continue
    }

    $relativePath = $request.Url.LocalPath.TrimStart("/")
    if ([string]::IsNullOrEmpty($relativePath)) {
      $relativePath = "index.html"
    }

    # Resolve to an absolute path, collapsing any ".." segments
    $filePath = [IO.Path]::GetFullPath((Join-Path $rootFull $relativePath))

    if (-not $filePath.StartsWith($rootFull, [StringComparison]::OrdinalIgnoreCase)) {
      $response.StatusCode = 403
    } elseif (Test-Path $filePath -PathType Leaf) {
      $bytes = [System.IO.File]::ReadAllBytes($filePath)
      $response.ContentType = Get-ContentType $filePath
      $response.ContentLength64 = $bytes.Length
      $response.OutputStream.Write($bytes, 0, $bytes.Length)
    } else {
      $response.StatusCode = 404
    }
    $response.OutputStream.Close()
  } catch {
    Write-Host "Error handling request: $_"
  }
}
