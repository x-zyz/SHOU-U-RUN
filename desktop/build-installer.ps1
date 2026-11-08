param(
    [string]$InnoCompiler = 'ISCC.exe',
    [string]$Dotnet = 'dotnet'
)

$ErrorActionPreference = 'Stop'
$project = Join-Path $PSScriptRoot 'ShouURun.Desktop.csproj'
[xml]$projectXml = Get-Content -LiteralPath $project -Raw
$version = $projectXml.Project.PropertyGroup.Version
if ($version -notmatch '^\d+\.\d+\.\d+$') { throw 'Expected a three-part Windows version in the project file.' }

$outputDir = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\local-build'))
New-Item -ItemType Directory -Force -Path $outputDir | Out-Null
$publishDir = Join-Path $outputDir ('windows-publish-' + [Guid]::NewGuid().ToString('N'))
try {
    & $Dotnet publish $project -c Release -o $publishDir
    if ($LASTEXITCODE -ne 0) { throw 'Windows application publish failed.' }

    & $InnoCompiler "/DAppVersion=$version" "/DPublishDir=$publishDir" "/O$outputDir" (Join-Path $PSScriptRoot 'installer.iss')
    if ($LASTEXITCODE -ne 0) { throw 'Installer compilation failed.' }
}
finally {
    $resolved = Resolve-Path -LiteralPath $publishDir -ErrorAction SilentlyContinue
    if ($resolved -and (Split-Path -Parent $resolved.Path) -eq $outputDir) {
        Remove-Item -LiteralPath $resolved.Path -Recurse -Force
    }
}
