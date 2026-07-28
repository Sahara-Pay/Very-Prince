<#
.SYNOPSIS
    Installs Terraform on Windows without WSL.
.DESCRIPTION
    Downloads and installs Terraform CLI via Chocolatey, Scoop, or direct zip download.
    Adds to user PATH for current session.
.NOTES
    Run in PowerShell as Administrator for Chocolatey/Scoop, or as current user for zip method.
#>

param(
    [string]$Version = "1.9.0",
    [ValidateSet('chocolatey', 'scoop', 'zip')]
    [string]$Method = 'zip'
)

$ErrorActionPreference = 'Stop'

Write-Host "Installing Terraform v$Version via $Method..." -ForegroundColor Cyan

switch ($Method) {
    'chocolatey' {
        if (-not (Get-Command choco -ErrorAction SilentlyContinue)) {
            throw "Chocolatey not installed. Run: Set-ExecutionPolicy Bypass -Scope Process -Force; [System.Net.ServicePointManager]::SecurityProtocol = [System.Net.ServicePointManager]::SecurityProtocol -bor 3072; iex ((New-Object System.Net.WebClient).DownloadString('https://community.chocolatey.org/install.ps1'))"
        }
        choco install terraform --version=$Version -y
    }
    'scoop' {
        if (-not (Get-Command scoop -ErrorAction SilentlyContinue)) {
            throw "Scoop not installed. Run: Set-ExecutionPolicy RemoteSigned -Scope CurrentUser; irm get.scoop.sh | iex"
        }
        scoop install terraform@$Version
    }
    'zip' {
        $url = "https://releases.hashicorp.com/terraform/${Version}/terraform_${Version}_windows_amd64.zip"
        $installDir = "$env:USERPROFILE\bin"
        $zipPath = "$env:TEMP\terraform_${Version}.zip"

        if (-not (Test-Path $installDir)) {
            New-Item -ItemType Directory -Path $installDir -Force | Out-Null
        }

        Write-Host "Downloading from $url..." -ForegroundColor Yellow
        Invoke-WebRequest -Uri $url -OutFile $zipPath

        Write-Host "Extracting to $installDir..." -ForegroundColor Yellow
        Expand-Archive -Path $zipPath -DestinationPath $installDir -Force

        # Add to PATH for current session
        $env:PATH += ";$installDir"
        
        # Persist to user PATH
        $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
        if ($userPath -notlike "*$installDir*") {
            [Environment]::SetEnvironmentVariable('Path', "$userPath;$installDir", 'User')
            Write-Host "Added $installDir to user PATH. Restart PowerShell to take effect." -ForegroundColor Green
        }
        
        Remove-Item $zipPath -Force
    }
}

Write-Host "Terraform installed: $(terraform -version)" -ForegroundColor Green
