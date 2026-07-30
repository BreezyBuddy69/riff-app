param(
  [Parameter(Mandatory = $true)][string]$ShortcutPath,
  [Parameter(Mandatory = $true)][string]$TargetPath,
  [string]$Arguments = '',
  [string]$WorkingDirectory = '',
  [string]$IconPath = ''
)

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($ShortcutPath)
$shortcut.TargetPath = $TargetPath
if ($Arguments) { $shortcut.Arguments = $Arguments }
if ($WorkingDirectory) { $shortcut.WorkingDirectory = $WorkingDirectory }
if ($IconPath -and (Test-Path $IconPath)) { $shortcut.IconLocation = $IconPath }
$shortcut.Save()
Write-Output "OK: $ShortcutPath"
