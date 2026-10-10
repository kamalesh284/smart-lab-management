# CampusLab Windows Agent Installer
# Must be executed as Administrator

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$SystemId,

    [Parameter(Mandatory = $true)]
    [string]$ApiUrl,

    [Parameter(Mandatory = $true)]
    [string]$Token,

    [Parameter(Mandatory = $false)]
    [string]$ConfigSource = "$PSScriptRoot\agent-config.example.json"
)

# 1. Administrator privilege check
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Write-Error "This installer must be run as Administrator."
    exit 1
}

# 2. Enforce HTTPS URL
if (-not ($ApiUrl -match '^https://')) {
    Write-Error "ApiUrl must use the https:// protocol. Plain HTTP is strictly disallowed for telemetry security."
    exit 1
}

# 3. Target Installation Directory
$installDir = "$env:ProgramData\CollegeLabMonitor"
Write-Host "Creating installation directory: $installDir" -ForegroundColor Cyan

if (-not (Test-Path -Path $installDir)) {
    New-Item -ItemType Directory -Path $installDir -Force | Out-Null
}

# 4. Copy agent script
$agentSrc = "$PSScriptRoot\agent.ps1"
if (-not (Test-Path -Path $agentSrc)) {
    Write-Error "agent.ps1 not found in $PSScriptRoot"
    exit 1
}
Copy-Item -Path $agentSrc -Destination "$installDir\agent.ps1" -Force

# 5. Build and save agent-config.json
$baseConfig = if (Test-Path -Path $ConfigSource) {
    Get-Content -Path $ConfigSource -Raw | ConvertFrom-Json
} else {
    [PSCustomObject]@{
        agentVersion = "1.0.0"
        reportIntervalSeconds = 60
        thresholds = @{
            cpuPercent = 90
            memoryPercent = 90
            diskFreePercent = 10
        }
        examSoftware = @()
    }
}

$baseConfig.systemId = $SystemId.Trim().ToUpper()
$baseConfig.apiUrl = $ApiUrl.Trim().TrimEnd('/')
$baseConfig.token = $Token.Trim()

$configDest = "$installDir\agent-config.json"
$baseConfig | ConvertTo-Json -Depth 6 | Set-Content -Path $configDest -Encoding UTF8
Write-Host "Wrote configured agent profile to: $configDest" -ForegroundColor Cyan

# 6. Secure NTFS Permissions (System & Administrators only)
Write-Host "Securing directory permissions..." -ForegroundColor Cyan
$acl = New-Object System.Security.AccessControl.DirectorySecurity
$acl.SetAccessRuleProtection($true, $false) # Disable inheritance and remove existing inherited rules

$adminGroup = New-Object System.Security.Principal.SecurityIdentifier([System.Security.Principal.WellKnownSidType]::BuiltinAdministratorsSid, $null)
$systemGroup = New-Object System.Security.Principal.SecurityIdentifier([System.Security.Principal.WellKnownSidType]::LocalSystemSid, $null)

$adminRule = New-Object System.Security.AccessControl.FileSystemAccessRule($adminGroup, "FullControl", "ContainerInherit, ObjectInherit", "None", "Allow")
$systemRule = New-Object System.Security.AccessControl.FileSystemAccessRule($systemGroup, "FullControl", "ContainerInherit, ObjectInherit", "None", "Allow")

$acl.AddAccessRule($adminRule)
$acl.AddAccessRule($systemRule)

Set-Acl -Path $installDir -AclObject $acl

# 7. Register Windows Scheduled Task
$taskName = "CollegeLabMonitorAgent"
Write-Host "Registering Scheduled Task: $taskName" -ForegroundColor Cyan

# Unregister old task if it exists
Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue

$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$installDir\agent.ps1`""

# Repetition interval: every 1 minute
$trigger = New-ScheduledTaskTrigger -AtStartup
$trigger.RepetitionInterval = (New-TimeSpan -Minutes 1)
$trigger.RepetitionDuration = (New-TimeSpan -Days 3650) # indefinitely

$principal = New-ScheduledTaskPrincipal -UserId "NT AUTHORITY\SYSTEM" -LogonType ServiceAccount -RunLevel Highest

$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances Parallel -StartWhenAvailable

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings | Out-Null

# 8. Start task immediately for initial heartbeat
Start-ScheduledTask -TaskName $taskName
Write-Host "CampusLab monitoring agent installed and started successfully for $SystemId!" -ForegroundColor Green
Write-Host "To inspect logs: Get-Content `"$installDir\agent.log`" -Tail 20" -ForegroundColor Yellow
