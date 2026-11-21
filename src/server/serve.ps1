param(
  [string]$Root = ".\dist",
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
    "\.html?"   { "text/html" }
    "\.js"      { "application/javascript" }
    "\.mjs"     { "application/javascript" }
    "\.css"     { "text/css" }
    "\.json"    { "application/json" }
    "\.wasm"    { "application/wasm" }
    "\.png"     { "image/png" }
    "\.jpe?g"   { "image/jpeg" }
    "\.gif"     { "image/gif" }
    "\.svg"     { "image/svg+xml" }
    "\.ico"     { "image/x-icon" }
    default     { "application/octet-stream" }
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

    if (-not $request.Url) {
      $response.StatusCode = 404
      $response.OutputStream.Close()
      continue
    }
    
    $relativePath = $request.Url.LocalPath
    if ($null -eq $relativePath) {
      $relativePath = ""
    }
    $relativePath = $relativePath.TrimStart("/")

    if ([string]::IsNullOrEmpty($relativePath)) {
      $relativePath = "index.html"
    }
    $filePath = Join-Path $Root $relativePath

    if (Test-Path $filePath) {
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