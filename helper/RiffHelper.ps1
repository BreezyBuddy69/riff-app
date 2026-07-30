# RiffHelper - persistenter Aktions-Helfer fuer Riff, geforkt aus Sable2s
# SableHelper.ps1 (websites/riff-MASTER-PROMPT.md §5/§8) statt neu
# geschrieben - die schwierigen Teile (DPI-korrekte Tasteninjektion, robustes
# UTF-8-Encoding trotz PowerShell-5.1-BOM-Fallen) sind dort bereits gehaertet.
# Ein Prozess, JSON-Lines-Protokoll ueber stdin/stdout:
#   Request:  {"id":1,"op":"keys","keys":"ctrl+v"}\n
#   Response: {"id":1,"ok":true,"result":{...}}\n  bzw. {"id":1,"ok":false,"error":"..."}\n
# Alle Koordinaten sind PHYSISCHE Pixel (der Prozess ist DPI-aware; die
# Umrechnung aus Electron-DIP macht der Main-Prozess ueber display.scaleFactor).
# Werte kommen ausschliesslich als JSON-Felder an - hier wird nie eine
# Shell-Befehlszeile aus Modell-Output zusammengesetzt.
#
# ponytail: Riff nutzt fuer v1 nur 'keys'/'type'/'key_state' (siehe helper.js/
# holdWatcher.js/toggleWatcher.js/typingEngine.js) - alle anderen Ops
# (click/drag/scroll/uia_*/window-Verwaltung/speak/...) sind unveraendert aus
# Sable2 mitgekommen und aktuell toter Code fuer dieses Produkt. Bewusst NICHT
# jetzt schon rausgeschnitten (Risiko, gemeinsame Hilfsfunktionen/Klassen
# kaputtzumachen, ohne jeden Pfad einzeln zu testen) - aufraeumen, sobald
# Phase 2 (read_context, §6.3/§8) den Helper ohnehin naeher anfasst.

$ErrorActionPreference = 'Stop'

# [Console]::OutputEncoding/InputEncoding wirken zuverlaessig nur bei einer
# ECHTEN Konsole - hier ist stdin/stdout von Node aus umgeleitet (spawn), und
# dabei blieben Sonderzeichen (Umlaute, Anfuehrungszeichen) in Fehlermeldungen
# bisher kaputt ("Element X nicht gefunden" mit Mojibake-Anfuehrungszeichen).
# Fix Teil 1: stdin/stdout explizit als UTF-8-ohne-BOM-Streams neu verdrahten,
# das funktioniert auch umgeleitet zuverlaessig. Fix Teil 2 (eigentliche
# Ursache): Windows PowerShell 5.1 liest .ps1-Dateien OHNE BOM mit der
# System-Codepage statt UTF-8 - dadurch wurden typografische Anfuehrungszeichen
# („ ") direkt im Quellcode schon beim Parsen kaputt eingelesen, lange bevor
# Output/Encoding ueberhaupt eine Rolle spielten. Deshalb unten nur noch
# ASCII-Anfuehrungszeichen in String-Literalen - robust unabhaengig von BOM.
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$stdoutWriter = New-Object System.IO.StreamWriter([Console]::OpenStandardOutput(), $utf8NoBom)
$stdoutWriter.AutoFlush = $true
[Console]::SetOut($stdoutWriter)
[Console]::SetIn((New-Object System.IO.StreamReader([Console]::OpenStandardInput(), $utf8NoBom)))

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms
# delete_file (Papierkorb statt endgueltigem Loeschen) - siehe D21.
Add-Type -AssemblyName Microsoft.VisualBasic
# Voice OS: TTS (System.Speech, SAPI - kein API-Key, kein Netzwerk, siehe D14).
# Ein einziges, modul-globales SpeechSynthesizer-Objekt: SpeakAsync() laeuft auf
# dessen eigenem Worker-Thread und darf den Request-Loop unten NICHT blockieren
# (der Helper bedient Klicks/Tippen etc. weiter waehrend Sable spricht) - dafuer
# muss das Objekt aber ueberleben, solange gesprochen wird, also modul-global
# statt lokal in der Funktion (sonst raeumt der GC mitten im Satz auf).
Add-Type -AssemblyName System.Speech
$script:synth = New-Object System.Speech.Synthesis.SpeechSynthesizer

# Strukturierter Fehlercode fuer die aktuelle Anfrage (main.js/helper.js
# lesen ihn aus dem Response-JSON, siehe D19) - an der Fehlerquelle gesetzt
# (Find-WindowElement/Invoke-UiClick), nie per Regex auf die Fehlermeldung
# geraten. Wird im Request-Loop unten pro Anfrage zurueckgesetzt.
$script:lastErrorCode = $null

# kill_process darf diese Prozesse NIEMALS beenden - autoritative Pruefung
# gegen den ECHTEN, per PID aufgeloesten Prozessnamen (Defense in depth
# neben dem Client-Vorabcheck in tools.js, siehe D21). "sable2"/"electron"
# schuetzt Sable vor einem versehentlichen Selbstmord.
$script:ProtectedProcessNames = @(
  'explorer', 'system', 'system idle process', 'idle', 'registry', 'smss',
  'csrss', 'wininit', 'winlogon', 'services', 'lsass', 'dwm', 'memcompression',
  'svchost', 'sable2', 'electron'
)

Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public struct SABLE_RECT { public int Left; public int Top; public int Right; public int Bottom; }
public struct SABLE_POINT { public int X; public int Y; }
public static class SableNative {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern IntPtr SetProcessDpiAwarenessContext(IntPtr value);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out SABLE_POINT p);
  [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, int dx, int dy, int dwData, UIntPtr dwExtraInfo);
  [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr FindWindow(string lpClassName, string lpWindowName);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out SABLE_RECT lpRect);
  [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr hWnd, int X, int Y, int nWidth, int nHeight, bool bRepaint);
  [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int vKey);
}
'@

# Per-Monitor-V2-DPI-Awareness (Win10 1703+), Fallback auf System-DPI-aware -
# danach sind alle Cursor-Koordinaten physische Pixel, auf jedem Monitor.
try {
  [void][SableNative]::SetProcessDpiAwarenessContext([IntPtr]::new(-4))
} catch {
  try { [void][SableNative]::SetProcessDPIAware() } catch {}
}

$MOUSEEVENTF_LEFTDOWN = 0x0002; $MOUSEEVENTF_LEFTUP = 0x0004
$MOUSEEVENTF_RIGHTDOWN = 0x0008; $MOUSEEVENTF_RIGHTUP = 0x0010
$MOUSEEVENTF_WHEEL = 0x0800
$KEYEVENTF_KEYUP = 0x0002

function Move-Cursor([int]$x, [int]$y) {
  [void][SableNative]::SetCursorPos($x, $y)
  Start-Sleep -Milliseconds 25
}

function Invoke-MouseButton([string]$button, [int]$clicks) {
  $down = if ($button -eq 'right') { $MOUSEEVENTF_RIGHTDOWN } else { $MOUSEEVENTF_LEFTDOWN }
  $up   = if ($button -eq 'right') { $MOUSEEVENTF_RIGHTUP } else { $MOUSEEVENTF_LEFTUP }
  for ($i = 0; $i -lt $clicks; $i++) {
    [SableNative]::mouse_event($down, 0, 0, 0, [UIntPtr]::Zero)
    [SableNative]::mouse_event($up, 0, 0, 0, [UIntPtr]::Zero)
    if ($clicks -gt 1) { Start-Sleep -Milliseconds 90 }
  }
}

$VK = @{
  'ctrl' = 0x11; 'alt' = 0x12; 'shift' = 0x10; 'win' = 0x5B
  # Maustasten (D40): nur fuer key_state-Abfragen (Klick-weg-Erkennung im
  # Sprachmodus) - Press-Combo wuerde mit ihnen nichts Sinnvolles tun.
  'lbutton' = 0x01; 'rbutton' = 0x02
  'enter' = 0x0D; 'tab' = 0x09; 'esc' = 0x1B; 'escape' = 0x1B; 'space' = 0x20
  'backspace' = 0x08; 'delete' = 0x2E; 'del' = 0x2E; 'home' = 0x24; 'end' = 0x23
  'pageup' = 0x21; 'pagedown' = 0x22; 'up' = 0x26; 'down' = 0x28; 'left' = 0x25; 'right' = 0x27
}
for ($i = 1; $i -le 12; $i++) { $VK["f$i"] = 0x6F + $i }
foreach ($c in 48..57) { $VK[[string][char]$c] = $c }            # 0-9
foreach ($c in 97..122) { $VK[[string][char]$c] = $c - 32 }      # a-z -> VK 'A'-'Z'

# Umlaute (D37-Folgefix, Nutzerwunsch "mit ä ü und ö natürlich"): deren VK-Code
# ist NICHT wie a-z ein fester ASCII-Offset, sondern layoutabhaengig (die OEM-
# Tasten sitzen bei DE/AT/CH-Layouts an unterschiedlichen physischen Stellen).
# VkKeyScanW loest zur Laufzeit auf, welcher VK-Code auf DIESEM System (mit der
# tatsaechlich aktiven Tastatur) 'ä'/'ö'/'ü' erzeugt, statt eine feste OEM-
# Konstante zu raten, die auf einer anderen Variante falsch waere.
Add-Type -MemberDefinition '[DllImport("user32.dll")] public static extern short VkKeyScanW(char ch);' -Name NativeKb -Namespace RiffKb
foreach ($ch in @('ä', 'ö', 'ü')) {
  $scan = [RiffKb.NativeKb]::VkKeyScanW($ch[0])
  # PowerShell-Variablen sind case-insensitiv - "$vkCode" statt "$vk", sonst
  # ueberschreibt das hier still die grosse $VK-Tabelle selbst (mit einem
  # Int32) und jeder Zugriff darauf crasht den Helper beim Start.
  $vkCode = $scan -band 0xFF
  # -1 (als Int16: beide Bytes 0xFF) = aktuelles Layout kennt das Zeichen nicht.
  if ($scan -ne -1) { $VK[$ch] = $vkCode }
}

function Press-Combo([string]$combo) {
  $parts = $combo.ToLower().Split('+') | Where-Object { $_ -ne '' }
  $mods = @(); $key = $null
  foreach ($p in $parts) {
    if ($p -in @('ctrl', 'alt', 'shift', 'win')) { $mods += $p } else { $key = $p }
  }
  if (-not $key -and $mods.Count -gt 0) { $key = $mods[-1]; $mods = $mods[0..($mods.Count - 2)] }
  if (-not $VK.ContainsKey($key)) { throw "Unbekannte Taste: $key" }
  foreach ($m in $mods) { [SableNative]::keybd_event([byte]$VK[$m], 0, 0, [UIntPtr]::Zero) }
  Start-Sleep -Milliseconds 20
  [SableNative]::keybd_event([byte]$VK[$key], 0, 0, [UIntPtr]::Zero)
  [SableNative]::keybd_event([byte]$VK[$key], 0, $KEYEVENTF_KEYUP, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 20
  [array]::Reverse($mods)
  foreach ($m in $mods) { [SableNative]::keybd_event([byte]$VK[$m], 0, $KEYEVENTF_KEYUP, [UIntPtr]::Zero) }
}

# Push-to-talk fuer Voice OS (siehe DECISIONS.md D16): Electrons globalShortcut
# kennt keinen Key-Up, ein echtes Halten-zum-Sprechen braucht daher Low-Level-Tastenstatus.
# Nutzt dieselbe $VK-Tabelle wie Press-Combo - "ctrl+alt+space" etc.
function Test-KeysDown([string]$combo) {
  $parts = $combo.ToLower().Split('+') | Where-Object { $_ -ne '' }
  foreach ($p in $parts) {
    if (-not $VK.ContainsKey($p)) { return $false }
    if (([SableNative]::GetAsyncKeyState($VK[$p]) -band 0x8000) -eq 0) { return $false }
  }
  return $true
}

function Escape-SendKeys([string]$text) {
  # SendKeys-Sonderzeichen in {} einschliessen, Zeilenumbrueche als {ENTER}.
  $sb = New-Object System.Text.StringBuilder
  foreach ($ch in $text.ToCharArray()) {
    if ($ch -eq "`r") { continue }
    if ($ch -eq "`n") { [void]$sb.Append('{ENTER}'); continue }
    if ('+^%~(){}[]'.Contains([string]$ch)) { [void]$sb.Append('{').Append($ch).Append('}') }
    else { [void]$sb.Append($ch) }
  }
  return $sb.ToString()
}

function Get-ForegroundInfo {
  $h = [SableNative]::GetForegroundWindow()
  $sb = New-Object System.Text.StringBuilder 512
  [void][SableNative]::GetWindowText($h, $sb, 512)
  $procId = [uint32]0
  [void][SableNative]::GetWindowThreadProcessId($h, [ref]$procId)
  $name = ''
  try { $name = (Get-Process -Id $procId -ErrorAction Stop).ProcessName } catch {}
  return @{ title = $sb.ToString(); app = $name; hwnd = [int64]$h }
}

function Find-WindowElement([string]$titlePart) {
  if (-not $titlePart) {
    $h = [SableNative]::GetForegroundWindow()
    return [System.Windows.Automation.AutomationElement]::FromHandle($h)
  }
  $root = [System.Windows.Automation.AutomationElement]::RootElement
  $windows = $root.FindAll([System.Windows.Automation.TreeScope]::Children,
    [System.Windows.Automation.Condition]::TrueCondition)
  foreach ($w in $windows) {
    if ($w.Current.Name -and $w.Current.Name.ToLower().Contains($titlePart.ToLower())) { return $w }
  }
  $script:lastErrorCode = 'WINDOW_NOT_FOUND'
  throw "Kein Fenster mit Titel '$titlePart' gefunden"
}

$ControlTypeMap = @{
  'Button' = [System.Windows.Automation.ControlType]::Button
  'MenuItem' = [System.Windows.Automation.ControlType]::MenuItem
  'ListItem' = [System.Windows.Automation.ControlType]::ListItem
  'TabItem' = [System.Windows.Automation.ControlType]::TabItem
  'CheckBox' = [System.Windows.Automation.ControlType]::CheckBox
  'RadioButton' = [System.Windows.Automation.ControlType]::RadioButton
  'Edit' = [System.Windows.Automation.ControlType]::Edit
  'Hyperlink' = [System.Windows.Automation.ControlType]::Hyperlink
  'TreeItem' = [System.Windows.Automation.ControlType]::TreeItem
  'ComboBox' = [System.Windows.Automation.ControlType]::ComboBox
  'Text' = [System.Windows.Automation.ControlType]::Text
  'SplitButton' = [System.Windows.Automation.ControlType]::SplitButton
}

function Find-UiElement($windowEl, [string]$name, [string]$controlType) {
  $nameCond = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::NameProperty, $name,
    [System.Windows.Automation.PropertyConditionFlags]::IgnoreCase)
  $cond = $nameCond
  if ($controlType -and $controlType -ne 'Any' -and $ControlTypeMap.ContainsKey($controlType)) {
    $typeCond = New-Object System.Windows.Automation.PropertyCondition(
      [System.Windows.Automation.AutomationElement]::ControlTypeProperty, $ControlTypeMap[$controlType])
    $cond = New-Object System.Windows.Automation.AndCondition($nameCond, $typeCond)
  }
  # 1. Exakter Name (case-insensitive) - der schnelle, praezise Pfad.
  $el = $windowEl.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $cond)
  if ($el) { return $el }
  # 2. Teilstring-Suche, begrenzt (grosse UI-Baeume, z.B. Browser): BFS mit Cap.
  $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
  $queue = New-Object System.Collections.Queue
  $queue.Enqueue($windowEl)
  $visited = 0
  $needle = $name.ToLower()
  while ($queue.Count -gt 0 -and $visited -lt 2500) {
    $node = $queue.Dequeue(); $visited++
    try {
      $child = $walker.GetFirstChild($node)
      while ($child) {
        $cname = $child.Current.Name
        if ($cname -and $cname.ToLower().Contains($needle)) {
          if ($controlType -eq 'Any' -or -not $controlType -or
              ($ControlTypeMap.ContainsKey($controlType) -and $child.Current.ControlType -eq $ControlTypeMap[$controlType])) {
            return $child
          }
        }
        $queue.Enqueue($child)
        $child = $walker.GetNextSibling($child)
      }
    } catch {}
  }
  return $null
}

function Invoke-UiClick($req) {
  $windowEl = Find-WindowElement $req.windowTitle
  $el = Find-UiElement $windowEl $req.element $req.controlType
  if (-not $el) {
    $script:lastErrorCode = 'ELEMENT_NOT_FOUND'
    throw "Element '$($req.element)' nicht gefunden"
  }
  $elName = $el.Current.Name
  $elType = $el.Current.ControlType.ProgrammaticName -replace '^ControlType\.', ''

  if ($req.button -ne 'right') {
    # Pattern-basiert zuerst: kein Cursor-Sprung, funktioniert auch verdeckt.
    foreach ($p in @([System.Windows.Automation.InvokePattern]::Pattern,
                     [System.Windows.Automation.TogglePattern]::Pattern,
                     [System.Windows.Automation.SelectionItemPattern]::Pattern,
                     [System.Windows.Automation.ExpandCollapsePattern]::Pattern)) {
      $pat = $null
      if ($el.TryGetCurrentPattern($p, [ref]$pat)) {
        switch ($p.ProgrammaticName) {
          'InvokePatternIdentifiers.Pattern' { $pat.Invoke(); return @{ via = 'InvokePattern'; element = $elName; type = $elType } }
          'TogglePatternIdentifiers.Pattern' { $pat.Toggle(); return @{ via = 'TogglePattern'; element = $elName; type = $elType } }
          'SelectionItemPatternIdentifiers.Pattern' { $pat.Select(); return @{ via = 'SelectionItemPattern'; element = $elName; type = $elType } }
          'ExpandCollapsePatternIdentifiers.Pattern' { $pat.Expand(); return @{ via = 'ExpandCollapsePattern'; element = $elName; type = $elType } }
        }
      }
    }
  }
  # Fallback (und immer bei Rechtsklick): echter Klick auf den ClickablePoint.
  $pt = $el.GetClickablePoint()
  Move-Cursor ([int]$pt.X) ([int]$pt.Y)
  Invoke-MouseButton $req.button 1
  return @{ via = 'ClickablePoint'; element = $elName; type = $elType; x = [int]$pt.X; y = [int]$pt.Y }
}

function Handle-Request($req) {
  switch ($req.op) {
    'ping' { return @{ pong = $true; pid = $PID } }
    'foreground' { return Get-ForegroundInfo }
    'taskbar_rect' {
      # Shell_TrayWnd bleibt bei Auto-Hide ein echtes Fenster - sein Rect
      # zeigt live, ob die Leiste gerade eingefahren (fast komplett ausserhalb
      # des Bildschirms) oder aufgeklappt (volle Hoehe sichtbar) ist. Damit
      # kann Sable seine Bar rechtzeitig hochruecken, statt von der
      # auftauchenden Taskleiste ueberdeckt zu werden.
      $h = [SableNative]::FindWindow('Shell_TrayWnd', $null)
      if ($h -eq [IntPtr]::Zero) { return @{ found = $false } }
      $rect = New-Object SABLE_RECT
      $ok = [SableNative]::GetWindowRect($h, [ref]$rect)
      if (-not $ok) { return @{ found = $false } }
      return @{ found = $true; left = $rect.Left; top = $rect.Top; right = $rect.Right; bottom = $rect.Bottom }
    }
    'click' {
      Move-Cursor ([int]$req.x) ([int]$req.y)
      Invoke-MouseButton $req.button ([int]$req.clicks)
      return @{ x = [int]$req.x; y = [int]$req.y }
    }
    'move' {
      Move-Cursor ([int]$req.x) ([int]$req.y)
      return @{ x = [int]$req.x; y = [int]$req.y }
    }
    'cursor_pos' {
      # Fehlte bisher komplett: es gab SetCursorPos, aber kein GetCursorPos -
      # das Modell konnte den Zeiger also setzen, aber nie erfahren, wo er
      # gerade steht. Damit war jede RELATIVE Bewegung ("ein Stueck nach
      # rechts") unmoeglich, und eine absolute Bewegung brauchte immer erst
      # einen Screenshot. Beides ist mit dieser Operation erledigt.
      $p = New-Object SABLE_POINT
      [void][SableNative]::GetCursorPos([ref]$p)
      return @{ x = $p.X; y = $p.Y }
    }
    'scroll' {
      Move-Cursor ([int]$req.x) ([int]$req.y)
      $delta = if ($req.direction -eq 'up') { 120 } else { -120 }
      for ($i = 0; $i -lt [int]$req.amount; $i++) {
        [SableNative]::mouse_event($MOUSEEVENTF_WHEEL, 0, 0, $delta, [UIntPtr]::Zero)
        Start-Sleep -Milliseconds 40
      }
      return @{ scrolled = [int]$req.amount }
    }
    'drag' {
      Move-Cursor ([int]$req.x1) ([int]$req.y1)
      [SableNative]::mouse_event($MOUSEEVENTF_LEFTDOWN, 0, 0, 0, [UIntPtr]::Zero)
      Start-Sleep -Milliseconds 120
      # Echte Zwischenschritte: viele Apps erkennen einen Drag nur mit
      # kontinuierlichen mousemove-Events, nicht bei einem Sofort-Sprung.
      $steps = 14
      for ($i = 1; $i -le $steps; $i++) {
        $nx = [int]($req.x1 + ($req.x2 - $req.x1) * $i / $steps)
        $ny = [int]($req.y1 + ($req.y2 - $req.y1) * $i / $steps)
        [void][SableNative]::SetCursorPos($nx, $ny)
        Start-Sleep -Milliseconds 14
      }
      [SableNative]::mouse_event($MOUSEEVENTF_LEFTUP, 0, 0, 0, [UIntPtr]::Zero)
      return @{ dragged = $true }
    }
    'type' {
      [System.Windows.Forms.SendKeys]::SendWait((Escape-SendKeys $req.text))
      return @{ typed = $req.text.Length }
    }
    'keys' {
      Press-Combo $req.keys
      return @{ pressed = $req.keys }
    }
    'open_app' {
      # Argument geht als eigener Parameter an Start-Process - kein Shell-String.
      # hidden=true startet die App ohne sichtbares Fenster (z.B. um eine Datei
      # nur zu registrieren/verarbeiten, ohne dem Nutzer etwas aufzureissen).
      # Nur bei echten Programmen wirksam - eine URL uebernimmt der Browser
      # ohnehin selbst, der ignoriert den Fensterstil.
      if ($req.hidden) {
        Start-Process -FilePath $req.app -WindowStyle Hidden
      } else {
        Start-Process -FilePath $req.app
      }
      return @{ started = $req.app; hidden = [bool]$req.hidden }
    }
    'focus_window' {
      $needle = $req.title.ToLower()
      $proc = Get-Process | Where-Object { $_.MainWindowTitle -and $_.MainWindowTitle.ToLower().Contains($needle) } | Select-Object -First 1
      if (-not $proc) { throw "Kein Fenster mit Titel '$($req.title)' gefunden" }
      $h = $proc.MainWindowHandle
      if ([SableNative]::IsIconic($h)) { [void][SableNative]::ShowWindow($h, 9) }
      [void][SableNative]::SetForegroundWindow($h)
      return @{ focused = $proc.MainWindowTitle }
    }
    'uia_click' { return Invoke-UiClick $req }
    'uia_list' {
      # Listet die BENANNTEN, bedienbaren Elemente eines Fensters als Text auf
      # (D34). Das ist der billige, praezise Gegenentwurf zum Screenshot: statt
      # dem Modell ein Bild zu schicken, aus dem es Buttonnamen RATEN muss
      # (Quelle von ELEMENT_NOT_FOUND), bekommt es die echten Namen direkt aus
      # dem UI-Automation-Baum - dieselbe Quelle, aus der Invoke-UiClick spaeter
      # sein Ziel aufloest. Was hier steht, ist also garantiert klickbar.
      $windowEl = Find-WindowElement $req.windowTitle
      $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
      $queue = New-Object System.Collections.Queue
      $queue.Enqueue($windowEl)
      $items = New-Object System.Collections.ArrayList
      $seen = New-Object System.Collections.Generic.HashSet[string]
      $visited = 0
      # Dieselbe Obergrenze wie die Teilstring-Suche in Find-UiElement: grosse
      # UI-Baeume (Browser!) sind sonst unbegrenzt tief.
      while ($queue.Count -gt 0 -and $visited -lt 2500 -and $items.Count -lt 120) {
        $node = $queue.Dequeue(); $visited++
        try {
          $child = $walker.GetFirstChild($node)
          while ($child) {
            $cur = $child.Current
            $cname = $cur.Name
            # Nur was einen Namen hat, sichtbar und aktiv ist - alles andere
            # kann ui_click ohnehin nicht treffen und waere nur Token-Ballast.
            if ($cname -and -not $cur.IsOffscreen -and $cur.IsEnabled) {
              $ctype = $cur.ControlType.ProgrammaticName -replace '^ControlType\.', ''
              $key = "$ctype|$cname"
              if ($seen.Add($key)) { [void]$items.Add(@{ name = $cname; type = $ctype }) }
            }
            $queue.Enqueue($child)
            $child = $walker.GetNextSibling($child)
          }
        } catch {}
      }
      $info = Get-ForegroundInfo
      $wtitle = if ($req.windowTitle) { $req.windowTitle } else { $info.title }
      return @{ window = $wtitle; elements = @($items); truncated = ($items.Count -ge 120) }
    }
    'wait_window' {
      # Wartet, bis ein Fenster mit dem Titel-Teilstring existiert (D34).
      # Bewusst MIT eigener Schleife im Helper, aber hart gedeckelt: der Helper
      # bedient Anfragen seriell, eine unbegrenzte Warteschleife wuerde Maus,
      # Tastatur und UI-Automation fuer die ganze Sitzung blockieren. main.js
      # setzt sein Helper-Timeout fuer diesen Op entsprechend hoeher.
      $needle = $req.title.ToLower()
      $timeoutMs = [int]$req.timeoutMs
      if ($timeoutMs -le 0 -or $timeoutMs -gt 30000) { $timeoutMs = 10000 }
      $sw = [System.Diagnostics.Stopwatch]::StartNew()
      while ($sw.ElapsedMilliseconds -lt $timeoutMs) {
        $proc = Get-Process | Where-Object { $_.MainWindowTitle -and $_.MainWindowTitle.ToLower().Contains($needle) } | Select-Object -First 1
        if ($proc) {
          return @{ found = $true; title = $proc.MainWindowTitle; app = $proc.ProcessName; waitedMs = [int]$sw.ElapsedMilliseconds }
        }
        Start-Sleep -Milliseconds 250
      }
      $script:lastErrorCode = 'WINDOW_TIMEOUT'
      throw "Fenster mit '$($req.title)' ist innerhalb von $([int]($timeoutMs/1000))s nicht erschienen"
    }
    'move_window' {
      # Fenster verschieben/groesse aendern/maximieren/minimieren/wiederherstellen
      # oder an einen Bildschirmrand snappen (D34). Bisher konnte Sable Fenster
      # nur fokussieren, schliessen und minimieren - "leg die beiden Fenster
      # nebeneinander" war schlicht nicht ausdrueckbar.
      $needle = $req.title.ToLower()
      $proc = Get-Process | Where-Object { $_.MainWindowTitle -and $_.MainWindowTitle.ToLower().Contains($needle) } | Select-Object -First 1
      if (-not $proc) {
        $script:lastErrorCode = 'WINDOW_NOT_FOUND'
        throw "Kein Fenster mit Titel '$($req.title)' gefunden"
      }
      $h = $proc.MainWindowHandle
      # Aus einem minimierten/maximierten Fenster laesst sich nicht sinnvoll
      # positionieren - erst wiederherstellen (SW_RESTORE = 9).
      if ($req.mode -ne 'maximize' -and $req.mode -ne 'minimize') {
        if ([SableNative]::IsIconic($h)) { [void][SableNative]::ShowWindow($h, 9) }
      }
      switch ($req.mode) {
        'maximize' { [void][SableNative]::ShowWindow($h, 3) }   # SW_MAXIMIZE
        'minimize' { [void][SableNative]::ShowWindow($h, 6) }   # SW_MINIMIZE
        'restore'  { [void][SableNative]::ShowWindow($h, 9) }   # SW_RESTORE
        default {
          # 'rect': x/y/w/h kommen als PHYSISCHE Pixel von main.js (dort aus
          # DIP*scaleFactor gerechnet - der Helper rechnet nie selbst um, siehe D5).
          [void][SableNative]::SetForegroundWindow($h)
          [void][SableNative]::MoveWindow($h, [int]$req.x, [int]$req.y, [int]$req.w, [int]$req.h, $true)
        }
      }
      $rect = New-Object SABLE_RECT
      [void][SableNative]::GetWindowRect($h, [ref]$rect)
      return @{
        title = $proc.MainWindowTitle; mode = $req.mode
        left = $rect.Left; top = $rect.Top; right = $rect.Right; bottom = $rect.Bottom
      }
    }
    'key_state' {
      # Fuer einen einzelnen (Nicht-Kombo-)Key liefert GetAsyncKeyState zwei
      # Bits: 0x8000 = "gerade jetzt gedrueckt" (Level), 0x0001 = "seit dem
      # letzten Aufruf mindestens einmal gedrueckt" (Kante, wird bei jeder
      # Abfrage zurueckgesetzt). Die Klick-weg-Erkennung im Sprachmodus (D40)
      # pollt nur alle paar hundert ms - ein Level-Check allein verpasst dabei
      # zuverlaessig jeden Klick, dessen Druecken+Loslassen komplett zwischen
      # zwei Polls liegt (das war der ~50%-Fehlschlag). 'pressed' (Kante) faengt
      # das ab, egal wie kurz der Klick war.
      $k = $req.keys
      if (($k -notmatch '\+') -and $VK.ContainsKey($k.ToLower())) {
        $state = [SableNative]::GetAsyncKeyState($VK[$k.ToLower()])
        return @{ down = (($state -band 0x8000) -ne 0); pressed = (($state -band 0x0001) -ne 0) }
      }
      return @{ down = (Test-KeysDown $k) }
    }
    'mods_state' {
      # Seiten-aufgeschluesselter Modifier-Status (Latenz-Optimierung, siehe
      # holdWatcher.js): GetAsyncKeyState mit VK_CONTROL/VK_MENU (0x11/0x12)
      # kann nicht zwischen links/rechts unterscheiden - noetig, um AltGr
      # (Windows synthetisiert das IMMER als LINKE Strg + RECHTE Alt) von
      # einer bewussten Zwei-Hand-Kombination zu trennen. VK_LCONTROL=0xA2,
      # VK_RCONTROL=0xA3, VK_LMENU=0xA4, VK_RMENU=0xA5 - fest & layoutunab-
      # haengig (anders als die OEM-Umlaut-Codes weiter oben).
      return @{
        ctrlLeft  = (([SableNative]::GetAsyncKeyState(0xA2) -band 0x8000) -ne 0)
        ctrlRight = (([SableNative]::GetAsyncKeyState(0xA3) -band 0x8000) -ne 0)
        altLeft   = (([SableNative]::GetAsyncKeyState(0xA4) -band 0x8000) -ne 0)
        altRight  = (([SableNative]::GetAsyncKeyState(0xA5) -band 0x8000) -ne 0)
      }
    }
    'speak' {
      if ($req.voice) { try { $script:synth.SelectVoice($req.voice) } catch {} }
      # CancelAll erst: eine neue Antwort soll die vorherige ablösen statt sich
      # dahinter einzureihen (sonst spricht Sable irgendwann mehrere Antworten
      # nacheinander nach, wenn der Nutzer schnell mehrfach fragt).
      $script:synth.SpeakAsyncCancelAll()
      [void]$script:synth.SpeakAsync($req.text)
      return @{ speaking = $true }
    }
    'stop_speaking' {
      $script:synth.SpeakAsyncCancelAll()
      return @{ stopped = $true }
    }
    'speaking_state' {
      # Fuer den Sprachmodus (D29): main pollt hiermit, ob SAPI noch spricht,
      # und schaltet das Mikrofon erst danach wieder scharf - sonst wuerde
      # die eigene TTS-Stimme transkribiert (Rueckkopplungsschleife).
      return @{ speaking = ($script:synth.State.ToString() -eq 'Speaking') }
    }
    'list_voices' {
      $names = @($script:synth.GetInstalledVoices() | Where-Object { $_.Enabled } | ForEach-Object { $_.VoiceInfo.Name })
      return @{ voices = $names }
    }
    'list_windows' {
      $items = Get-Process | Where-Object { $_.MainWindowTitle } | Select-Object -First 60 ProcessName, Id, MainWindowTitle
      $arr = @($items | ForEach-Object { @{ app = $_.ProcessName; pid = $_.Id; title = $_.MainWindowTitle } })
      return @{ windows = $arr }
    }
    'list_processes' {
      $all = Get-Process
      $items = $all | Sort-Object ProcessName | Select-Object -First 300 ProcessName, Id
      $arr = @($items | ForEach-Object { @{ name = $_.ProcessName; pid = $_.Id } })
      return @{ processes = $arr; truncated = ($all.Count -gt 300) }
    }
    'close_window' {
      $needle = $req.title.ToLower()
      $proc = Get-Process | Where-Object { $_.MainWindowTitle -and $_.MainWindowTitle.ToLower().Contains($needle) } | Select-Object -First 1
      if (-not $proc) {
        $script:lastErrorCode = 'WINDOW_NOT_FOUND'
        throw "Kein Fenster mit Titel '$($req.title)' gefunden"
      }
      [void]$proc.CloseMainWindow()
      return @{ closed = $proc.MainWindowTitle }
    }
    'minimize_window' {
      $needle = $req.title.ToLower()
      $proc = Get-Process | Where-Object { $_.MainWindowTitle -and $_.MainWindowTitle.ToLower().Contains($needle) } | Select-Object -First 1
      if (-not $proc) {
        $script:lastErrorCode = 'WINDOW_NOT_FOUND'
        throw "Kein Fenster mit Titel '$($req.title)' gefunden"
      }
      [void][SableNative]::ShowWindow($proc.MainWindowHandle, 6)
      return @{ minimized = $proc.MainWindowTitle }
    }
    'recycle' {
      # delete_file: in den Papierkorb, NICHT endgueltig (kein Remove-Item -Force) - siehe D21.
      $full = $req.path
      if (-not (Test-Path -LiteralPath $full)) { throw "Pfad nicht gefunden: $full" }
      if (Test-Path -LiteralPath $full -PathType Container) {
        [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($full, 'OnlyErrorDialogs', 'SendToRecycleBin')
      } else {
        [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($full, 'OnlyErrorDialogs', 'SendToRecycleBin')
      }
      return @{ recycled = $full }
    }
    'kill_process' {
      # Autoritative Blacklist-Pruefung gegen den ECHTEN, per PID aufgeloesten
      # Prozessnamen - unabhaengig vom Client-Vorabcheck in tools.js (D21).
      $proc = Get-Process -Id ([int]$req.pid) -ErrorAction Stop
      $pname = $proc.ProcessName
      if ($script:ProtectedProcessNames -contains $pname.ToLower()) {
        $script:lastErrorCode = 'PROTECTED_PROCESS'
        throw "Geschuetzter Systemprozess kann nicht beendet werden: $pname"
      }
      Stop-Process -Id $proc.Id -Force
      return @{ killed = $pname; pid = $proc.Id }
    }
    default { throw "Unbekannte Operation: $($req.op)" }
  }
}

# Bereitschaft signalisieren, dann Request-Loop.
[Console]::Out.WriteLine('{"ready":true}')
[Console]::Out.Flush()

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if (-not $line.Trim()) { continue }
  $id = $null
  $script:lastErrorCode = $null
  try {
    $req = $line | ConvertFrom-Json
    $id = $req.id
    $result = Handle-Request $req
    $resp = @{ id = $id; ok = $true; result = $result } | ConvertTo-Json -Compress -Depth 6
  } catch {
    $errObj = @{ id = $id; ok = $false; error = $_.Exception.Message }
    if ($script:lastErrorCode) { $errObj.code = $script:lastErrorCode }
    $resp = $errObj | ConvertTo-Json -Compress -Depth 4
  }
  [Console]::Out.WriteLine($resp)
  [Console]::Out.Flush()
}
