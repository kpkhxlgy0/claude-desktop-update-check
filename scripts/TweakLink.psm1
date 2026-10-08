Set-StrictMode -Version Latest

$ErrorActionPreference = "Stop"

function Resolve-NormalizedPath
{
    param(
        [Parameter(Mandatory)] [string] $Path,
        [string] $BasePath)

    $candidate = if ([System.IO.Path]::IsPathRooted($Path))
    {
        $Path
    }
    elseif ($BasePath)
    {
        Join-Path $BasePath $Path
    }
    else
    {
        Join-Path (Get-Location).Path $Path
    }
    return [System.IO.Path]::GetFullPath($candidate).TrimEnd(
        [System.IO.Path]::DirectorySeparatorChar,
        [System.IO.Path]::AltDirectorySeparatorChar)
}

function Resolve-ComparableDirectoryTarget
{
    param([Parameter(Mandatory)] [string] $Path)

    $normalized = Resolve-NormalizedPath $Path
    try
    {
        $directory = [System.IO.DirectoryInfo]::new($normalized)
        if (!$directory.Exists) { return $null }

        $finalTarget = $directory.ResolveLinkTarget($true)
        $comparisonPath = if ($null -eq $finalTarget)
        {
            $normalized
        }
        else
        {
            Resolve-NormalizedPath $finalTarget.FullName
        }

        if (!([System.IO.Directory]::Exists($comparisonPath))) { return $null }
        return $comparisonPath
    }
    catch
    {
        return $null
    }
}

function Test-PathEqual
{
    param(
        [Parameter(Mandatory)] [string] $Left,
        [Parameter(Mandatory)] [string] $Right)

    $resolvedLeft = Resolve-ComparableDirectoryTarget $Left
    $resolvedRight = Resolve-ComparableDirectoryTarget $Right
    if ($null -eq $resolvedLeft -or $null -eq $resolvedRight) { return $false }

    return [string]::Equals(
        $resolvedLeft,
        $resolvedRight,
        [System.StringComparison]::OrdinalIgnoreCase)
}

function Get-TweakLinkState
{
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [string] $LinkPath,
        [Parameter(Mandatory)] [string] $ExpectedTarget)

    $normalizedLink = Resolve-NormalizedPath $LinkPath
    $expected = Resolve-NormalizedPath $ExpectedTarget
    $item = Get-Item -LiteralPath $normalizedLink -Force -ErrorAction SilentlyContinue
    if ($null -eq $item)
    {
        return [pscustomobject] @{
            Status = "Missing"
            LinkPath = $normalizedLink
            Target = $null
        }
    }

    $isReparsePoint = ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0
    $linkTypeProperty = $item.PSObject.Properties["LinkType"]
    $targetProperty = $item.PSObject.Properties["Target"]
    if (!$isReparsePoint -or
        $null -eq $linkTypeProperty -or
        ![string]::Equals(
            [string] $linkTypeProperty.Value,
            "Junction",
            [System.StringComparison]::OrdinalIgnoreCase) -or
        $null -eq $targetProperty -or
        @($targetProperty.Value).Count -eq 0)
    {
        return [pscustomobject] @{
            Status = "Unsafe"
            LinkPath = $normalizedLink
            Target = $null
        }
    }

    $rawTarget = [string] @($targetProperty.Value)[0]
    $target = if ([System.IO.Path]::IsPathRooted($rawTarget))
    {
        Resolve-NormalizedPath $rawTarget
    }
    else
    {
        Resolve-NormalizedPath $rawTarget (Split-Path $normalizedLink -Parent)
    }
    $status = if (Test-PathEqual $target $expected) { "Current" } else { "WrongTarget" }
    return [pscustomobject] @{
        Status = $status
        LinkPath = $normalizedLink
        Target = $target
    }
}

function Set-TweakJunction
{
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [string] $LinkPath,
        [Parameter(Mandatory)] [string] $ExpectedTarget)

    $target = Resolve-NormalizedPath $ExpectedTarget
    if (!(Test-Path -LiteralPath $target -PathType Container))
    {
        throw "Tweak source directory not found: $target"
    }
    if (!(Test-Path -LiteralPath (Join-Path $target "manifest.json") -PathType Leaf))
    {
        throw "Tweak manifest not found below: $target"
    }

    $state = Get-TweakLinkState -LinkPath $LinkPath -ExpectedTarget $target
    if ($state.Status -eq "Current") { return $false }
    if ($state.Status -eq "Unsafe")
    {
        throw "The live tweak path is a real directory or unsupported reparse point and will not be replaced: $LinkPath"
    }

    $parent = Split-Path (Resolve-NormalizedPath $LinkPath) -Parent
    New-Item -ItemType Directory -Path $parent -Force | Out-Null
    $previousTarget = $state.Target
    if ($state.Status -eq "WrongTarget")
    {
        Remove-Item -LiteralPath $state.LinkPath -Force
    }

    try
    {
        New-Item -ItemType Junction -Path $state.LinkPath -Target $target | Out-Null
    }
    catch
    {
        $linkAfterFailure = Get-Item -LiteralPath $state.LinkPath -Force -ErrorAction SilentlyContinue
        if ($previousTarget -and
            (Test-Path -LiteralPath $previousTarget -PathType Container) -and
            $null -eq $linkAfterFailure)
        {
            New-Item -ItemType Junction -Path $state.LinkPath -Target $previousTarget | Out-Null
        }
        throw
    }

    $verified = Get-TweakLinkState -LinkPath $state.LinkPath -ExpectedTarget $target
    if ($verified.Status -ne "Current")
    {
        throw "Tweak junction verification failed: $($verified.Status)"
    }
    return $true
}

function Remove-TweakLink
{
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [string] $LinkPath,
        [Parameter(Mandatory)] [string] $ExpectedTarget)

    $state = Get-TweakLinkState -LinkPath $LinkPath -ExpectedTarget $ExpectedTarget
    if ($state.Status -eq "Missing") { return $false }
    if ($state.Status -eq "WrongTarget")
    {
        throw "The live tweak Junction points to another target and will not be removed: $($state.LinkPath)"
    }
    if ($state.Status -eq "Unsafe")
    {
        throw "The live tweak path is a real directory or unsupported reparse point and will not be removed: $($state.LinkPath)"
    }

    Remove-Item -LiteralPath $state.LinkPath -Force
    if ($null -ne (Get-Item -LiteralPath $state.LinkPath -Force -ErrorAction SilentlyContinue))
    {
        throw "The tweak link still exists after removal: $($state.LinkPath)"
    }
    return $true
}

Export-ModuleMember -Function @(
    "Get-TweakLinkState",
    "Set-TweakJunction",
    "Remove-TweakLink")
