<#
Usage:
  .\FileRenamer.ps1 -Action deextend -Path "path\to\target\directory"
  .\FileRenamer.ps1 -Action reextend -Path "path\to\target\directory"
#>

param(
  [ValidateSet("deextend", "reextend")]
  [string]$Action,
  [string]$Path
)

#Set-ExecutionPolicy -Scope Process -ExecutionPolicy Unrestricted

function DeExtend-Files{
  param (
    [string]$RootPath
  )

  $Extensions = @(
    ".bat"
    ".css",
    ".js",
    ".ps1"
  )

  if (-not (Test-Path -Path $RootPath -PathType Container)) {
    Write-Host "The specified path does not exist or is not a directory."
    exit
  }

  Get-ChildItem -Path $RootPath -Recurse -File | ForEach-Object {
    $ext = $_.Extension.Trim().ToLower()
    $isGz = $ext -eq ".gz"

    $checkExt = $isGz ? [System.IO.Path]::GetExtension($_.BaseName).ToLower() : $ext

    if ($Extensions -contains $checkExt) {
      $newName = $isGz ? "$($_.BaseName).txt.gz" : "$($_.FullName).txt"
      Write-Host "Renaming '$($_.FullName)' to '$newName'"
      Rename-Item -Path $_.FullName -NewName $newName
    }
  }
}

function ReExtend-Files{
  param (
    [string]$RootPath
  )
  
  if (-not (Test-Path -Path $RootPath -PathType Container)) {
    Write-Host "The specified path does not exist or is not a directory."
    exit
  }

  Get-ChildItem -Path $RootPath -Recurse -File | ForEach-Object {
    $fileName = $_.Name
    $isGz = ($_.Extension.Trim().ToLower() -eq ".gz")
    
    $baseName = $isGz ? $_.BaseName : $fileName

    if ($baseName -match "^(.+)\.(.+)\.txt$") {
      $newName = $isGz ? "$($matches[1]).$($matches[2]).gz" : "$($matches[1]).$($matches[2])"
      Write-Host "Renaming '$fileName' to '$newName'"
      Rename-Item -Path $_.FullName -NewName $newName
    }
  }
}

if ($Action -and $Path) {
  switch ($Action.ToLower()) {
    "deextend" { DeExtend-Files -RootPath $Path }
    "reextend" { ReExtend-Files -RootPath $Path }
    default { Write-Host "Invalid action. Use 'deextend' or 'reextend'."}
  }
}