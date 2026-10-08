#Requires -Version 7.2

[CmdletBinding()]
param([switch] $CheckOnly)

$ErrorActionPreference = "Stop"

Import-Module (Join-Path $PSScriptRoot "scripts/TweakLink.psm1") -Force

try
{
    if (!$env:APPDATA) { throw "APPDATA is not available." }
    $linkPath = Join-Path $env:APPDATA "claude-plusplus/tweaks/com.kpk.claude-desktop-update-check"
    $linkState = Get-TweakLinkState -LinkPath $linkPath -ExpectedTarget $PSScriptRoot
    $status = switch ($linkState.Status)
    {
        "Missing" { "NotInjected" }
        "Current" { "UninjectRequired" }
        default { "Blocked" }
    }

    Write-Host "Status: $status"
    Write-Host "Tweak link: $linkPath"
    if ($linkState.Target) { Write-Host "Current target: $($linkState.Target)" }

    if ($status -eq "Blocked")
    {
        if ($linkState.Status -eq "WrongTarget")
        {
            [Console]::Error.WriteLine(
                "Blocked [WrongTarget]: the live Tweak Junction points to another source and will not be removed.")
        }
        else
        {
            [Console]::Error.WriteLine(
                "Blocked [UnsafeLink]: the live Tweak path is a real directory or unsupported reparse point.")
        }
        exit 2
    }
    if ($CheckOnly -or $status -eq "NotInjected") { exit 0 }

    Remove-TweakLink -LinkPath $linkPath -ExpectedTarget $PSScriptRoot | Out-Null
    $verified = Get-TweakLinkState -LinkPath $linkPath -ExpectedTarget $PSScriptRoot
    if ($verified.Status -ne "Missing")
    {
        throw "Tweak Junction still exists after removal: $($verified.Status)"
    }
    Write-Host "Removed the Claude Desktop Update Check Tweak Junction. Restart Claude to unload it."
}
catch
{
    Write-Error $_
    exit 1
}
