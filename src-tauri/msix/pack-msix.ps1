<#
.SYNOPSIS
  Packs the built Postgres Studio executable into an MSIX for the Microsoft Store.

.DESCRIPTION
  Run after `npx tauri build --no-bundle` on Windows. Lays out the package
  (the executable, the Store logos and the filled-in AppxManifest.xml) and
  packs it with makeappx.exe from the Windows SDK. The package is left
  unsigned: the Store signs it after certification.

  The identity values come from Partner Center > the app > Product
  management > Product identity.

.EXAMPLE
  ./src-tauri/msix/pack-msix.ps1 -IdentityName "12345Edney.PostgresStudio" `
    -Publisher "CN=00000000-0000-0000-0000-000000000000" -PublisherDisplayName "Edney"
#>
param(
  [Parameter(Mandatory)] [string] $IdentityName,
  [Parameter(Mandatory)] [string] $Publisher,
  [Parameter(Mandatory)] [string] $PublisherDisplayName,
  # The name reserved in Partner Center.
  [string] $DisplayName = "Postgres Studio",
  [ValidateSet("x64", "arm64")] [string] $Arch = "x64",
  # Defaults to tauri.conf.json's version, as MSIX's four parts.
  [string] $Version,
  [string] $OutDir = "src-tauri/target/msix"
)

$ErrorActionPreference = "Stop"
$root = Resolve-Path (Join-Path $PSScriptRoot "../..")
$tauri = Join-Path $root "src-tauri"

if (-not $Version) {
  $conf = Get-Content (Join-Path $tauri "tauri.conf.json") -Raw | ConvertFrom-Json
  $Version = $conf.version
}
# The Store wants Major.Minor.Build.0: the fourth part is reserved.
$parts = @($Version -split '[.-]' | Select-Object -First 3 | ForEach-Object { [int]$_ })
while ($parts.Count -lt 3) { $parts += 0 }
$msixVersion = "{0}.{1}.{2}.0" -f $parts[0], $parts[1], $parts[2]

$target = if ($Arch -eq "arm64") { "aarch64-pc-windows-msvc" } else { $null }
$releaseDir = if ($target) { Join-Path $tauri "target/$target/release" } else { Join-Path $tauri "target/release" }
$exe = Get-ChildItem $releaseDir -Filter "postgres-studio.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $exe) { throw "No postgres-studio.exe in $releaseDir. Run 'npx tauri build --no-bundle' first." }

$layout = Join-Path $root "$OutDir/layout-$Arch"
if (Test-Path $layout) { Remove-Item $layout -Recurse -Force }
New-Item -ItemType Directory -Force (Join-Path $layout "Assets") | Out-Null
Copy-Item $exe.FullName (Join-Path $layout $exe.Name)
foreach ($logo in "StoreLogo", "Square44x44Logo", "Square71x71Logo", "Square150x150Logo") {
  Copy-Item (Join-Path $tauri "icons/$logo.png") (Join-Path $layout "Assets/$logo.png")
}

# XML-escape what goes into attributes and text.
function Esc([string] $s) { [System.Security.SecurityElement]::Escape($s) }
$manifest = Get-Content (Join-Path $PSScriptRoot "AppxManifest.xml") -Raw
$values = @{
  IDENTITY_NAME          = $IdentityName
  PUBLISHER              = $Publisher
  PUBLISHER_DISPLAY_NAME = $PublisherDisplayName
  DISPLAY_NAME           = $DisplayName
  VERSION                = $msixVersion
  ARCH                   = $Arch
  EXECUTABLE             = $exe.Name
}
foreach ($key in $values.Keys) { $manifest = $manifest.Replace("{{$key}}", (Esc $values[$key])) }
if ($manifest -match '\{\{[A-Z_]+\}\}') { throw "Unfilled value in the manifest: $($Matches[0])" }
[xml]$manifest | Out-Null  # fails here on malformed XML rather than in makeappx
Set-Content (Join-Path $layout "AppxManifest.xml") $manifest -Encoding UTF8

# makeappx.exe ships with the Windows SDK; take the newest one installed.
$makeappx = Get-ChildItem "${env:ProgramFiles(x86)}\Windows Kits\10\bin\*\x64\makeappx.exe" -ErrorAction SilentlyContinue |
  Sort-Object { [version]($_.Directory.Parent.Name) } -Descending | Select-Object -First 1
if (-not $makeappx) { throw "makeappx.exe not found: install the Windows 10/11 SDK." }

$package = Join-Path $root "$OutDir/PostgresStudio_${msixVersion}_$Arch.msix"
& $makeappx.FullName pack /d $layout /p $package /o /h SHA256
if ($LASTEXITCODE -ne 0) { throw "makeappx failed with exit code $LASTEXITCODE" }
Write-Host "Packed $package ($IdentityName $msixVersion, $Arch)"
if ($env:GITHUB_OUTPUT) { "package=$package" | Out-File $env:GITHUB_OUTPUT -Append -Encoding utf8 }
