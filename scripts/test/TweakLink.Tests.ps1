#Requires -Version 7.2

$ErrorActionPreference = "Stop"

function Assert-Equal
{
    param($Actual, $Expected, [string] $Message)
    if ($Actual -ne $Expected) { throw "$Message. Expected '$Expected', received '$Actual'." }
}

function Invoke-EntryPoint
{
    param([string] $Path, [string[]] $Arguments = @())
    $output = & $script:PwshPath -NoProfile -File $Path @Arguments 2>&1
    return [pscustomobject] @{
        ExitCode = $LASTEXITCODE
        Text = $output -join [Environment]::NewLine
    }
}

function Assert-Status
{
    param($Result, [int] $ExitCode, [string] $Status, [string] $Message)
    Assert-Equal $Result.ExitCode $ExitCode "$Message exit code"
    if ($Result.Text -notmatch "Status: $Status") { throw "$Message status: $($Result.Text)" }
}

function Should-Throw
{
    param([scriptblock] $Action, [string] $Pattern)
    $caughtError = $null
    try
    {
        & $Action
    }
    catch
    {
        $caughtError = $_
    }
    if ($null -eq $caughtError) { throw "Expected action to throw: $Pattern" }
    if ($caughtError.Exception.Message -notmatch $Pattern) { throw $caughtError }
}

function Remove-FixtureItem
{
    param([Parameter(Mandatory)] [string] $Path)

    $absolutePath = [System.IO.Path]::GetFullPath($Path).TrimEnd(
        [System.IO.Path]::DirectorySeparatorChar,
        [System.IO.Path]::AltDirectorySeparatorChar)
    $comparison = [System.StringComparison]::OrdinalIgnoreCase
    if (!$absolutePath.StartsWith($script:TempBoundary, $comparison) -or
        !([string]::Equals($absolutePath, $script:FixtureRoot, $comparison) -or
            $absolutePath.StartsWith($script:FixtureBoundary, $comparison)))
    {
        throw "Refusing to clean up a path outside the owned native-temp fixture: $absolutePath"
    }

    $item = Get-Item -LiteralPath $absolutePath -Force -ErrorAction SilentlyContinue
    if ($null -eq $item) { return }
    if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0)
    {
        Remove-Item -LiteralPath $absolutePath -Force
        return
    }
    if ($item.PSIsContainer)
    {
        foreach ($child in Get-ChildItem -LiteralPath $absolutePath -Force)
        {
            Remove-FixtureItem $child.FullName
        }
    }
    Remove-Item -LiteralPath $absolutePath -Force
}

$nonThrowingGuardFailed = $false
try
{
    Should-Throw {} "guard action exception"
}
catch
{
    if ($_.Exception.Message -notmatch "^Expected action to throw: guard action exception$") { throw }
    $nonThrowingGuardFailed = $true
}
if (!$nonThrowingGuardFailed) { throw "Should-Throw accepted a non-throwing action." }

$repositoryRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$modulePath = Join-Path $repositoryRoot "scripts/TweakLink.psm1"
$injectPath = Join-Path $repositoryRoot "Inject-ClaudePlusPlus.ps1"
$uninjectPath = Join-Path $repositoryRoot "Uninject-ClaudePlusPlus.ps1"
$script:PwshPath = (Get-Process -Id $PID).Path
$systemTemp = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath()).TrimEnd(
    [System.IO.Path]::DirectorySeparatorChar,
    [System.IO.Path]::AltDirectorySeparatorChar)
$script:TempBoundary = $systemTemp + [System.IO.Path]::DirectorySeparatorChar
$script:FixtureRoot = [System.IO.Path]::GetFullPath((Join-Path $systemTemp (
    "claude-desktop-update-check-link-tests-" + [guid]::NewGuid().ToString("N"))))
$script:FixtureBoundary = $script:FixtureRoot + [System.IO.Path]::DirectorySeparatorChar
$originalAppData = $env:APPDATA

try
{
    $env:APPDATA = Join-Path $script:FixtureRoot "AppData/Roaming"
    $linkPath = Join-Path $env:APPDATA "claude-plusplus/tweaks/com.kpk.claude-desktop-update-check"
    $sibling = Join-Path $env:APPDATA "claude-plusplus/tweaks/keep.txt"

    # A missing entry point or broken APPDATA routing must fail before module setup.
    $injectCheck = Invoke-EntryPoint $injectPath @("-CheckOnly")
    $uninjectCheck = Invoke-EntryPoint $uninjectPath @("-CheckOnly")
    if ($injectCheck.ExitCode -ne 0 -or $uninjectCheck.ExitCode -ne 0)
    {
        throw "Entry point checks failed: Inject exit $($injectCheck.ExitCode); Uninject exit $($uninjectCheck.ExitCode).`n$($injectCheck.Text)`n$($uninjectCheck.Text)"
    }
    Assert-Status $injectCheck 0 "LinkRequired" "Missing Inject check"
    Assert-Status $uninjectCheck 0 "NotInjected" "Missing Uninject check"
    if (Test-Path -LiteralPath $env:APPDATA) { throw "CheckOnly created an APPDATA directory." }
    Assert-Status (Invoke-EntryPoint $uninjectPath) 0 "NotInjected" "Missing Uninject apply"
    if (Test-Path -LiteralPath $env:APPDATA) { throw "Missing Uninject created an APPDATA directory." }

    Import-Module $modulePath -Force
    Assert-Equal (Get-TweakLinkState $linkPath $repositoryRoot).Status "Missing" "Missing state"
    Assert-Status (Invoke-EntryPoint $injectPath) 0 "LinkRequired" "Initial Inject apply"
    Assert-Equal (Get-TweakLinkState $linkPath $repositoryRoot).Status "Current" "Inject created expected junction"
    $initialTarget = (Get-Item -LiteralPath $linkPath -Force).Target
    Assert-Status (Invoke-EntryPoint $injectPath @("-CheckOnly")) 0 "Current" "Current Inject check"
    Assert-Status (Invoke-EntryPoint $injectPath) 0 "Current" "Idempotent Inject apply"
    Assert-Equal (Get-Item -LiteralPath $linkPath -Force).Target $initialTarget "Idempotent Inject target"
    Assert-Equal (Set-TweakJunction $linkPath $repositoryRoot) $false "Idempotent module apply"
    Assert-Status (Invoke-EntryPoint $uninjectPath @("-CheckOnly")) 0 "UninjectRequired" "Current Uninject check"
    Assert-Equal (Get-TweakLinkState $linkPath $repositoryRoot).Status "Current" "Uninject CheckOnly preserved junction"

    $wrongTarget = Join-Path $script:FixtureRoot "wrong-target"
    New-Item -ItemType Directory -Path $wrongTarget -Force | Out-Null
    $wrongTargetSentinel = Join-Path $wrongTarget "sentinel.txt"
    [System.IO.File]::WriteAllText($wrongTargetSentinel, "keep")
    Remove-TweakLink -LinkPath $linkPath -ExpectedTarget $repositoryRoot | Out-Null
    New-Item -ItemType Junction -Path $linkPath -Target $wrongTarget | Out-Null
    Assert-Equal (Get-TweakLinkState $linkPath $repositoryRoot).Status "WrongTarget" "Wrong target state"
    foreach ($arguments in @(@("-CheckOnly"), @()))
    {
        $blocked = Invoke-EntryPoint $uninjectPath $arguments
        Assert-Status $blocked 2 "Blocked" "Wrong-target Uninject"
        if ($blocked.Text -notmatch "WrongTarget") { throw "Missing wrong-target refusal: $($blocked.Text)" }
        Assert-Equal (Get-TweakLinkState $linkPath $repositoryRoot).Status "WrongTarget" "Wrong-target Uninject preserved junction"
        Assert-Equal ([System.IO.File]::ReadAllText($wrongTargetSentinel)) "keep" "Wrong-target Uninject preserved target contents"
    }
    Should-Throw { Remove-TweakLink -LinkPath $linkPath -ExpectedTarget $repositoryRoot } "another target"
    Assert-Status (Invoke-EntryPoint $injectPath @("-CheckOnly")) 0 "LinkRequired" "Wrong-target Inject check"
    Assert-Equal (Get-TweakLinkState $linkPath $repositoryRoot).Status "WrongTarget" "Wrong-target Inject CheckOnly preserved junction"
    Assert-Status (Invoke-EntryPoint $injectPath) 0 "LinkRequired" "Wrong-target Inject apply"
    Assert-Equal (Get-TweakLinkState $linkPath $repositoryRoot).Status "Current" "Inject replaced wrong-target junction"
    Assert-Equal ([System.IO.File]::ReadAllText($wrongTargetSentinel)) "keep" "Inject preserved wrong-target contents"

    $repositoryAlias = Join-Path $script:FixtureRoot "repository-alias"
    New-Item -ItemType Junction -Path $repositoryAlias -Target $repositoryRoot | Out-Null
    Remove-TweakLink -LinkPath $linkPath -ExpectedTarget $repositoryRoot | Out-Null
    New-Item -ItemType Junction -Path $linkPath -Target $repositoryAlias | Out-Null
    Assert-Equal (Get-TweakLinkState $linkPath $repositoryRoot).Status "Current" "Equivalent alias state"
    Assert-Status (Invoke-EntryPoint $injectPath) 0 "Current" "Equivalent alias Inject"
    Assert-Equal (Get-Item -LiteralPath $linkPath -Force).Target $repositoryAlias "Equivalent alias Inject preserved target"
    Assert-Status (Invoke-EntryPoint $uninjectPath) 0 "UninjectRequired" "Equivalent alias Uninject"
    if (Test-Path -LiteralPath $linkPath) { throw "Uninject left the alias-target junction behind." }
    Assert-Equal (Get-Item -LiteralPath $repositoryAlias -Force).LinkType "Junction" "Uninject preserved repository alias"
    if (!(Test-Path -LiteralPath (Join-Path $repositoryRoot "manifest.json") -PathType Leaf))
    {
        throw "Uninject removed source contents through the repository alias."
    }

    New-Item -ItemType Directory -Path $linkPath -Force | Out-Null
    $directorySentinel = Join-Path $linkPath "keep.txt"
    [System.IO.File]::WriteAllText($directorySentinel, "keep")
    Assert-Equal (Get-TweakLinkState $linkPath $repositoryRoot).Status "Unsafe" "Real directory state"
    Should-Throw { Set-TweakJunction $linkPath $repositoryRoot } "real directory"
    Should-Throw { Remove-TweakLink -LinkPath $linkPath -ExpectedTarget $repositoryRoot } "real directory"
    foreach ($entryPoint in @($injectPath, $uninjectPath))
    {
        foreach ($arguments in @(@("-CheckOnly"), @()))
        {
            Assert-Status (Invoke-EntryPoint $entryPoint $arguments) 2 "Blocked" "Real-directory refusal"
            Assert-Equal ([System.IO.File]::ReadAllText($directorySentinel)) "keep" "Blocked entry point preserved real-directory contents"
        }
    }
    Remove-FixtureItem $linkPath

    $symbolicTarget = Join-Path $script:FixtureRoot "symbolic-target"
    New-Item -ItemType Directory -Path $symbolicTarget -Force | Out-Null
    $symbolicSentinel = Join-Path $symbolicTarget "keep.txt"
    [System.IO.File]::WriteAllText($symbolicSentinel, "keep")
    New-Item -ItemType SymbolicLink -Path $linkPath -Target $symbolicTarget | Out-Null
    Assert-Equal (Get-TweakLinkState $linkPath $repositoryRoot).Status "Unsafe" "Symbolic link state"
    Should-Throw { Set-TweakJunction $linkPath $repositoryRoot } "unsupported reparse point"
    Should-Throw { Remove-TweakLink -LinkPath $linkPath -ExpectedTarget $repositoryRoot } "unsupported reparse point"
    foreach ($entryPoint in @($injectPath, $uninjectPath))
    {
        foreach ($arguments in @(@("-CheckOnly"), @()))
        {
            Assert-Status (Invoke-EntryPoint $entryPoint $arguments) 2 "Blocked" "Symbolic-link refusal"
            Assert-Equal (Get-Item -LiteralPath $linkPath -Force).LinkType "SymbolicLink" "Blocked entry point preserved symbolic link"
            Assert-Equal ([System.IO.File]::ReadAllText($symbolicSentinel)) "keep" "Blocked entry point preserved symbolic-target contents"
        }
    }
    Remove-FixtureItem $linkPath

    Assert-Status (Invoke-EntryPoint $injectPath) 0 "LinkRequired" "Final Inject apply"
    [System.IO.File]::WriteAllText($sibling, "keep")
    Assert-Status (Invoke-EntryPoint $uninjectPath) 0 "UninjectRequired" "Final Uninject apply"
    if (Test-Path -LiteralPath $linkPath) { throw "Uninject left the tweak junction behind." }
    Assert-Equal ([System.IO.File]::ReadAllText($sibling)) "keep" "Uninject preserved sibling file"
    if (!(Test-Path -LiteralPath (Join-Path $repositoryRoot "manifest.json") -PathType Leaf))
    {
        throw "Uninject removed source contents."
    }
    Assert-Status (Invoke-EntryPoint $uninjectPath) 0 "NotInjected" "Idempotent Uninject apply"
}
finally
{
    $env:APPDATA = $originalAppData
    Remove-FixtureItem $script:FixtureRoot
}

Write-Host "PASS Claude Desktop Update Check Junction safety"
