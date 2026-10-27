# Shusseki — prepare the PC Mobile Hotspot for the ESP32.
#
# The ESP32 has a 2.4 GHz-only radio. Windows' Mobile Hotspot defaults its band
# to "Auto", which broadcasts on 5 GHz when the upstream is 5 GHz — the ESP32
# then never sees the AP (serial shows `STA disconnected, reason=201`).
#
# This sets the hotspot to a known SSID/passphrase AND forces 2.4 GHz. Run it
# once per session (the band can reset when the hotspot restarts).
#
#   powershell -ExecutionPolicy Bypass -File C:\dev\shusseki\scripts\hotspot-24ghz.ps1
#
# Override via env if your values differ:
#   $env:SHUSSEKI_HOTSPOT_SSID="Shusseki-Room"; $env:SHUSSEKI_HOTSPOT_PASS="shusseki123"
param(
  [string]$Ssid = $(if ($env:SHUSSEKI_HOTSPOT_SSID) { $env:SHUSSEKI_HOTSPOT_SSID } else { "Shusseki-Room" }),
  [string]$Pass = $(if ($env:SHUSSEKI_HOTSPOT_PASS) { $env:SHUSSEKI_HOTSPOT_PASS } else { "shusseki123" })
)

Add-Type -AssemblyName System.Runtime.WindowsRuntime
[Windows.Networking.Connectivity.NetworkInformation, Windows.Networking.Connectivity, ContentType = WindowsRuntime] | Out-Null
[Windows.Networking.NetworkOperators.NetworkOperatorTetheringManager, Windows.Networking.NetworkOperators, ContentType = WindowsRuntime] | Out-Null
[Windows.Networking.NetworkOperators.NetworkOperatorTetheringAccessPointConfiguration, Windows.Networking.NetworkOperators, ContentType = WindowsRuntime] | Out-Null
[Windows.Networking.NetworkOperators.TetheringWiFiBand, Windows.Networking.NetworkOperators, ContentType = WindowsRuntime] | Out-Null

$profile = [Windows.Networking.Connectivity.NetworkInformation]::GetInternetConnectionProfile()
if (-not $profile) { Write-Error "No internet connection profile; connect the PC to WiFi first."; exit 1 }

$mgr = [Windows.Networking.NetworkOperators.NetworkOperatorTetheringManager]::CreateFromConnectionProfile($profile)
if ($mgr.TetheringOperationalState -ne "On") {
  $mgr.StartTetheringAsync() | Out-Null
  Start-Sleep -Seconds 3
}

$cfg = New-Object Windows.Networking.NetworkOperators.NetworkOperatorTetheringAccessPointConfiguration
$cfg.Ssid = $Ssid
$cfg.Passphrase = $Pass
try { $cfg.Band = [Windows.Networking.NetworkOperators.TetheringWiFiBand]::TwoPointFourGigahertz } catch {
  Write-Warning "Could not set the band (older Windows): $($_.Exception.Message)"
}

$mgr.ConfigureAccessPointAsync($cfg) | Out-Null
Start-Sleep -Seconds 4

$now = $mgr.GetCurrentAccessPointConfiguration()
Write-Output "hotspot SSID : $($now.Ssid)"
Write-Output "hotspot band : $($now.Band)   (want TwoPointFourGigahertz)"
Write-Output "gateway IP   : 192.168.137.1"
Write-Output "state        : $($mgr.TetheringOperationalState)"
