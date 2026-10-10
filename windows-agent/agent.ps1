# CampusLab Windows Monitoring Agent
# Runs under SYSTEM or Administrator to report health metrics to the monitoring API

[CmdletBinding()]
param(
    [string]$ConfigPath = "$PSScriptRoot\agent-config.json"
)

$ErrorActionPreference = 'Continue'
$LogFile = "$PSScriptRoot\agent.log"

function Write-AgentLog {
    param([string]$Message, [string]$Level = 'INFO')
    $timestamp = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
    $entry = "[$timestamp] [$Level] $Message"
    try {
        Add-Content -Path $LogFile -Value $entry -ErrorAction SilentlyContinue
    } catch {
        Write-Output $entry
    }
}

if (-not (Test-Path -Path $ConfigPath)) {
    Write-AgentLog "Config file not found at: $ConfigPath" -Level 'ERROR'
    exit 1
}

try {
    $configRaw = Get-Content -Path $ConfigPath -Raw -ErrorAction Stop
    $config = $configRaw | ConvertFrom-Json
} catch {
    Write-AgentLog "Failed to parse JSON config: $($_.Exception.Message)" -Level 'ERROR'
    exit 1
}

$systemId = $config.systemId
$apiUrl = $config.apiUrl.TrimEnd('/')
$token = $config.token
$agentVersion = if ($config.agentVersion) { $config.agentVersion } else { '1.0.0' }
$thresholds = $config.thresholds

# 1. Hardware Metrics Collection
$alerts = [System.Collections.Generic.List[string]]::new()

# CPU
try {
    $cpuMeasure = Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average
    $cpuPercent = [Math]::Round([double]$cpuMeasure.Average, 1)
} catch {
    $cpuPercent = 0.0
}

# Memory
try {
    $os = Get-CimInstance Win32_OperatingSystem
    $totalMem = [double]$os.TotalVisibleMemorySize
    $freeMem = [double]$os.FreePhysicalMemory
    $memoryPercent = [Math]::Round((($totalMem - $freeMem) / $totalMem) * 100, 1)
} catch {
    $memoryPercent = 0.0
}

# System Disk (C:)
try {
    $drive = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='C:'"
    $freeBytes = [double]$drive.FreeSpace
    $totalBytes = [double]$drive.Size
    $diskFreeGb = [Math]::Round(($freeBytes / 1GB), 1)
    $diskFreePercent = [Math]::Round((($freeBytes / $totalBytes) * 100), 1)
} catch {
    $diskFreeGb = 0.0
    $diskFreePercent = 0.0
}

# Threshold Checks
if ($thresholds) {
    if ($thresholds.cpuPercent -and $cpuPercent -ge $thresholds.cpuPercent) {
        $alerts.Add("cpu_high_$([int]$cpuPercent)_percent")
    }
    if ($thresholds.memoryPercent -and $memoryPercent -ge $thresholds.memoryPercent) {
        $alerts.Add("memory_high_$([int]$memoryPercent)_percent")
    }
    if ($thresholds.diskFreePercent -and $diskFreePercent -le $thresholds.diskFreePercent) {
        $alerts.Add("disk_free_low_$([int]$diskFreePercent)_percent")
    }
}

# 2. Exam Software Checks
$softwareReports = [System.Collections.Generic.List[object]]::new()

if ($config.examSoftware) {
    foreach ($app in $config.examSoftware) {
        $isInstalled = $false
        $isRunning = $false

        # Check binary installation paths
        if ($app.paths) {
            foreach ($p in $app.paths) {
                if (Test-Path -Path $p) {
                    $isInstalled = $true
                    break
                }
            }
        }

        # Check running processes
        if ($app.processNames) {
            foreach ($proc in $app.processNames) {
                $pClean = [System.IO.Path]::GetFileNameWithoutExtension($proc)
                if (Get-Process -Name $pClean -ErrorAction SilentlyContinue) {
                    $isInstalled = $true
                    $isRunning = $true
                    break
                }
            }
        }

        # Check Windows Services
        if ($app.serviceNames) {
            foreach ($svc in $app.serviceNames) {
                $service = Get-Service -Name $svc -ErrorAction SilentlyContinue
                if ($service) {
                    $isInstalled = $true
                    if ($service.Status -eq 'Running') {
                        $isRunning = $true
                    }
                }
            }
        }

        $state = if ($isRunning) { 'running' } elseif ($isInstalled) { 'stopped' } else { 'missing' }

        if ($app.required -and -not $isInstalled) {
            $alerts.Add("missing_$($app.id)")
        }

        $softwareReports.Add([PSCustomObject]@{
            id = $app.id
            name = $app.name
            installed = $isInstalled
            running = $isRunning
            state = $state
        })
    }
}

$agentStatus = if ($alerts.Count -gt 0) { 'needs_attention' } else { 'online' }

# 3. Payload Construction
$payload = [PSCustomObject]@{
    systemId = $systemId
    hostname = $env:COMPUTERNAME
    agentVersion = $agentVersion
    agentStatus = $agentStatus
    hardware = [PSCustomObject]@{
        cpuPercent = $cpuPercent
        memoryPercent = $memoryPercent
        diskFreeGb = $diskFreeGb
        diskFreePercent = $diskFreePercent
    }
    examSoftware = $softwareReports
    alerts = $alerts
}

$jsonBody = $payload | ConvertTo-Json -Depth 5 -Compress

# 4. HTTPS Post Report
$targetEndpoint = "$apiUrl/api/v1/monitoring/report"
$headers = @{
    'Authorization' = "Bearer $token"
    'Content-Type'  = 'application/json'
}

# Require TLS 1.2+
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

try {
    $response = Invoke-RestMethod -Uri $targetEndpoint -Method Post -Headers $headers -Body $jsonBody -TimeoutSec 15
    Write-AgentLog "Heartbeat reported successfully. Status: $agentStatus, Alerts: $($alerts.Count)"
} catch {
    $statusCode = $_.Exception.Response.StatusCode.value__
    $errorMsg = $_.Exception.Message
    Write-AgentLog "Failed to report heartbeat (HTTP $statusCode): $errorMsg" -Level 'WARNING'
}
