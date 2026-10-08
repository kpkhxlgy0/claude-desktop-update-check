#Requires -Version 7.2

[CmdletBinding()]
param([switch] $CheckOnly)

$ErrorActionPreference = "Stop"

Import-Module (Join-Path $PSScriptRoot "scripts/TweakLink.psm1") -Force

try
{
    if (!$env:APPDATA) { throw "APPDATA is not available." }
    if (!(Test-Path -LiteralPath (Join-Path $PSScriptRoot "manifest.json") -PathType Leaf))
    {
        throw "Tweak manifest is missing from: $PSScriptRoot"
    }

    $linkPath = Join-Path $env:APPDATA "claude-plusplus/tweaks/com.kpk.claude-desktop-update-check"
    $linkState = Get-TweakLinkState -LinkPath $linkPath -ExpectedTarget $PSScriptRoot
    $status = switch ($linkState.Status)
    {
        "Current" { "Current" }
        "Unsafe" { "Blocked" }
        default { "LinkRequired" }
    }

    Write-Host "Status: $status"
    Write-Host "Tweak source: $PSScriptRoot"
    Write-Host "Tweak link: $linkPath"
    if ($linkState.Target) { Write-Host "Current target: $($linkState.Target)" }

    if ($status -eq "Blocked")
    {
        [Console]::Error.WriteLine(
            "Blocked [UnsafeLink]: the live Tweak path is a real directory or unsupported reparse point.")
        exit 2
    }
    if ($CheckOnly) { exit 0 }

    $changed = Set-TweakJunction -LinkPath $linkPath -ExpectedTarget $PSScriptRoot
    $verified = Get-TweakLinkState -LinkPath $linkPath -ExpectedTarget $PSScriptRoot
    if ($verified.Status -ne "Current")
    {
        throw "Tweak Junction verification failed: $($verified.Status)"
    }
    if ($changed)
    {
        Write-Host "Created the Claude Desktop Update Check Tweak Junction. Restart Claude to load it."
    }
    else
    {
        Write-Host "The Claude Desktop Update Check Tweak Junction is already current."
    }
}
catch
{
    Write-Error $_
    exit 1
}
