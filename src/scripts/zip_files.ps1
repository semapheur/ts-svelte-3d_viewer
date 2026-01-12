<#
Usage:
  .\Zipper.ps1 -Action zip -Path "path\to\target\directory"
  .\Zipper.ps1 -Action unzip -Path "path\to\target\directory"
#>

param(
  [ValidateSet("zip", "unzip")]
  [string]$Action,
  [string]$Path
)

#Set-ExecutionPolicy -Scope Process -ExecutionPolicy Unrestricted

function Unzip-Files{
  param (
    [string]$SourcePath,
    [string]$TargetPath
  )

  if (-not (Test-Path -Path $SourcePath -PathType Container)) {
    Write-Host "The specified path does not exist or is not a directory."
    exit
  }

  Get-ChildItem -Path $SourcePath -Filter *.zip | ForEach-Object {
    $zipFile = $_.FullName

    if ($TargetPath) {
      $unzipFolder = Join-Path -Path $TargetPath -ChildPath ($_.BaseName)
    } else {
      $unzipFolder = Join-Path -Path $SourcePath -ChildPath ($_.BaseName)
    }

    if (-not (Test-Path -Path $unzipFolder)) {
      New-Item -ItemType Directory -Path $unzipFolder | Out-Null
    }

    Write-Host "Unzipping '$zipFile' to '$unzipFolder'"
    Expand-Archive -Path $zipFile -DestinationPath $unzipFolder -Force

    Write-Host "Deleting $zipFile ..."
    Remove-Item -Path $zipFile -Force
  }
}

if ($Action -and $Path) {
  switch ($Action.ToLower()) {
    "unzip" { Unzip-Files -SourcePath $Path }
    default { Write-Host "Invalid action. Use 'zip' or 'unzip'."}
  }
}