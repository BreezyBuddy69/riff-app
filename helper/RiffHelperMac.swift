// RiffHelperMac - macOS-Gegenstueck zu RiffHelper.ps1 (Windows). Implementiert
// NUR die Ops, die Riff tatsaechlich benutzt (siehe ponytail-Kommentar in
// RiffHelper.ps1 Zeile 13: 'ping'/'foreground'/'type'/'keys'/'key_state'/
// 'mods_state') - kein 1:1-Port des kompletten Sable-Erbes (click/drag/
// uia_*/speak/... existieren fuer Riff nicht, waren schon auf Windows toter
// Code). Gleiches JSON-Lines-Protokoll ueber stdin/stdout wie das PS1-Skript,
// damit helper.js (main-Prozess) NICHT plattformabhaengig verzweigen muss:
//   Request:  {"id":1,"op":"keys","keys":"ctrl+v"}\n
//   Response: {"id":1,"ok":true,"result":{...}}\n  bzw. {"id":1,"ok":false,"error":"..."}\n
//
// UNGETESTET (2026-08-03): kein Mac zum Kompilieren/Ausfuehren verfuegbar -
// dieser Code ist bis zur echten Verifikation auf einem GitHub-Actions-
// macOS-Runner bzw. echter Hardware NICHT vertrauenswuerdig, nur plausibel
// nach Doku. Siehe Riffs Projekt-Memory fuer den Verifikationsplan.
//
// Berechtigungen: macOS verlangt fuer synthetische Tastatur-Events UND fuers
// Lesen des Fensterttitels einer fremden App explizit "Bedienungshilfen"
// (Accessibility) in Systemeinstellungen -> Datenschutz & Sicherheit - ohne
// das liefert type/keys stillschweigend nichts UND foreground.title bleibt
// leer (siehe foregroundInfo()). Anders als Windows: kein Fallback moeglich,
// das ist von Apple so vorgeschrieben, kein Riff-Bug.

import Foundation
import AppKit
import ApplicationServices

// ---------- Tastencode-Tabelle ----------
// Mac-Virtualcodes sind HARDWARE-Positionen (Carbon/HIToolbox-Konstanten),
// nicht wie Windows-VKs ueber ASCII herleitbar. ponytail: fest verdrahtete
// US-QWERTY-Positionen fuer a-z/0-9 - auf einer deutschen QWERTZ-Tastatur
// sind Y und Z physisch vertauscht (analog zur Windows-Umlaut-Lehre in
// RiffHelper.ps1 D13). Betrifft NUR eigene Nutzer-Shortcuts mit Y/Z, die
// Riff-Defaults (ctrl+alt, ctrl+alt+d, alt+shift+p/o) sind nicht betroffen.
// Upgrade-Pfad falls ein Nutzer das meldet: UCKeyTranslate mit dem aktiven
// Layout aufloesen, wie VkKeyScanW auf der Windows-Seite.
let KEYCODES: [String: CGKeyCode] = [
  "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9,
  "b": 11, "q": 12, "w": 13, "e": 14, "r": 15, "y": 16, "t": 17,
  "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "9": 25, "7": 26, "8": 28, "0": 29,
  "o": 31, "u": 32, "i": 34, "p": 35, "l": 37, "j": 38, "k": 40, "n": 45, "m": 46,
  "enter": 36, "tab": 48, "space": 49, "backspace": 51, "escape": 53, "esc": 53,
  "left": 123, "right": 124, "down": 125, "up": 126,
  "home": 115, "end": 119, "pageup": 116, "pagedown": 121, "delete": 117, "del": 117,
  "f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97, "f7": 98, "f8": 100,
  "f9": 101, "f10": 109, "f11": 103, "f12": 111,
]
// Modifier - eigene Konstanten statt in KEYCODES, weil sie bei key_state/
// mods_state ANDERS behandelt werden als bei press (siehe unten).
let VK_CTRL: CGKeyCode = 59
let VK_CTRL_R: CGKeyCode = 62
let VK_ALT: CGKeyCode = 58   // Option/Alt links
let VK_ALT_R: CGKeyCode = 61 // Option/Alt rechts
let VK_SHIFT: CGKeyCode = 56
let VK_SHIFT_R: CGKeyCode = 60
let VK_CMD: CGKeyCode = 55

// key_state/mods_state (Hotkey-ERKENNUNG, siehe holdWatcher.js/toggleWatcher.js):
// 'ctrl' = physisches Control, nicht Cmd - der Nutzer haelt genau das, was er
// in den Einstellungen konfiguriert hat.
func modifierKeycodeForDetection(_ name: String) -> CGKeyCode? {
  switch name {
  case "ctrl": return VK_CTRL
  case "alt": return VK_ALT
  case "shift": return VK_SHIFT
  case "win", "cmd": return VK_CMD
  default: return nil
  }
}

// keys-Op (Aktions-SIMULATION fuer die drei fest verdrahteten Aufrufe aus
// typingEngine.js/transforms.js: 'ctrl+v', 'ctrl+c', 'backspace'). Diese
// Strings meinen "der OS-Standard-Shortcut fuers Einfuegen/Kopieren", nicht
// woertlich die Control-Taste - auf dem Mac ist das Cmd+V/Cmd+C, nicht
// Strg+V/Strg+C (das macht in den meisten Mac-Apps gar nichts). Deshalb HIER
// bewusst eine andere Abbildung als bei der Hotkey-Erkennung oben - siehe
// Datei-Kommentar am Kopf dieser Datei.
func modifierKeycodeForAction(_ name: String) -> CGKeyCode? {
  switch name {
  case "ctrl": return VK_CMD // OS-Shortcut-Bedeutung, nicht woertlich
  case "alt": return VK_ALT
  case "shift": return VK_SHIFT
  case "win", "cmd": return VK_CMD
  default: return nil
  }
}

func keycodeFor(_ name: String) -> CGKeyCode? {
  return KEYCODES[name.lowercased()]
}

// ---------- Tasten druecken/pruefen ----------
struct HelperError: Error { let message: String }

func postKey(_ code: CGKeyCode, down: Bool) {
  let src = CGEventSource(stateID: .hidSystemState)
  guard let ev = CGEvent(keyboardEventSource: src, virtualKey: code, keyDown: down) else { return }
  ev.post(tap: .cghidEventTap)
}

// Press-Combo-Aequivalent zu RiffHelper.ps1: Mods runter (Reihenfolge egal),
// 20ms warten, Haupttaste tippen, 20ms warten, Mods in umgekehrter
// Reihenfolge wieder hoch. actionMapping=true fuer den keys-Op (siehe oben).
func pressCombo(_ combo: String, useActionMapping: Bool) throws {
  let parts = combo.lowercased().split(separator: "+").map(String.init).filter { !$0.isEmpty }
  var mods: [String] = []
  var mainKey: String? = nil
  for p in parts {
    if ["ctrl", "alt", "shift", "win", "cmd"].contains(p) { mods.append(p) } else { mainKey = p }
  }
  if mainKey == nil, let last = mods.popLast() { mainKey = last }
  guard let key = mainKey else { throw HelperError(message: "Keine Haupttaste in Kombination: \(combo)") }
  let mapFn = useActionMapping ? modifierKeycodeForAction : modifierKeycodeForDetection
  let modCodes = mods.compactMap { mapFn($0) }
  guard let keyCode = keycodeFor(key) ?? mapFn(key) else {
    throw HelperError(message: "Unbekannte Taste: \(key)")
  }
  for m in modCodes { postKey(m, down: true) }
  usleep(20_000)
  postKey(keyCode, down: true)
  postKey(keyCode, down: false)
  usleep(20_000)
  for m in modCodes.reversed() { postKey(m, down: false) }
}

// key_state: fuer Riff zaehlt nur 'down' (siehe holdWatcher.js/toggleWatcher.js
// - 'pressed'/Flanken-Feld aus der Windows-Fassung wird von Riffs JS-Code
// nirgends gelesen, deshalb hier nicht nachgebaut).
func isKeysDown(_ combo: String) -> Bool {
  let parts = combo.lowercased().split(separator: "+").map(String.init).filter { !$0.isEmpty }
  for p in parts {
    guard let code = modifierKeycodeForDetection(p) ?? keycodeFor(p) else { return false }
    if !CGEventSource.keyState(.combinedSessionState, key: code) { return false }
  }
  return !parts.isEmpty
}

func modsState() -> [String: Any] {
  return [
    "ctrlLeft": CGEventSource.keyState(.combinedSessionState, key: VK_CTRL),
    "ctrlRight": CGEventSource.keyState(.combinedSessionState, key: VK_CTRL_R),
    "altLeft": CGEventSource.keyState(.combinedSessionState, key: VK_ALT),
    "altRight": CGEventSource.keyState(.combinedSessionState, key: VK_ALT_R),
  ]
}

// ---------- Text tippen ----------
// CGEvent kann einen kompletten Unicode-String in EINEM Event injizieren
// (keyboardSetUnicodeString) - robuster als Windows' SendKeys-Ansatz mit
// Sonderzeichen-Escaping, weil hier kein Zeichen-fuer-Zeichen-Mapping auf
// Virtualcodes noetig ist (Umlaute, Emoji etc. funktionieren ohne Sonderfall).
func typeText(_ text: String) {
  let src = CGEventSource(stateID: .hidSystemState)
  guard let down = CGEvent(keyboardEventSource: src, virtualKey: 0, keyDown: true) else { return }
  let utf16 = Array(text.utf16)
  down.keyboardSetUnicodeString(stringLength: utf16.count, unicodeString: utf16)
  down.post(tap: .cghidEventTap)
  guard let up = CGEvent(keyboardEventSource: src, virtualKey: 0, keyDown: false) else { return }
  up.keyboardSetUnicodeString(stringLength: utf16.count, unicodeString: utf16)
  up.post(tap: .cghidEventTap)
}

// ---------- Vordergrund-App ----------
// app = lokalisierter Name (z.B. "Notes", "Safari") - dictationRouter.js
// nutzt das nur als Anzeige-Label (D18: faellt der Call aus, fehlt nur das
// Label, das Diktat laeuft unveraendert weiter), title ist best-effort ueber
// die Accessibility-API und bleibt leer, wenn die Berechtigung fehlt oder
// die App keine AX-Titel-Info herausgibt - wirft dafuer NIE, exakt wie die
// Windows-Fassung "faehrt den Hot-Path nie aus".
func foregroundInfo() -> [String: Any] {
  guard let app = NSWorkspace.shared.frontmostApplication else {
    return ["app": "", "title": ""]
  }
  var title = ""
  let axApp = AXUIElementCreateApplication(app.processIdentifier)
  var winRef: CFTypeRef?
  if AXUIElementCopyAttributeValue(axApp, kAXFocusedWindowAttribute as CFString, &winRef) == .success,
     let win = winRef {
    var titleRef: CFTypeRef?
    // swiftlint: force-cast ist hier sicher, AXUIElementCopyAttributeValue
    // liefert bei .success garantiert einen AXUIElement-kompatiblen Typ.
    if AXUIElementCopyAttributeValue(win as! AXUIElement, kAXTitleAttribute as CFString, &titleRef) == .success,
       let t = titleRef as? String {
      title = t
    }
  }
  return ["app": app.localizedName ?? "", "title": title]
}

// ---------- JSON-Lines-Protokoll ----------
func handleRequest(_ req: [String: Any]) throws -> [String: Any] {
  guard let op = req["op"] as? String else { throw HelperError(message: "Kein 'op' im Request") }
  switch op {
  case "ping":
    return ["pong": true, "pid": ProcessInfo.processInfo.processIdentifier]
  case "foreground":
    return foregroundInfo()
  case "type":
    let text = (req["text"] as? String) ?? ""
    typeText(text)
    return ["typed": text.count]
  case "keys":
    let keys = (req["keys"] as? String) ?? ""
    try pressCombo(keys, useActionMapping: true)
    return ["pressed": keys]
  case "key_state":
    let keys = (req["keys"] as? String) ?? ""
    return ["down": isKeysDown(keys)]
  case "mods_state":
    return modsState()
  default:
    throw HelperError(message: "Unbekannte Operation: \(op)")
  }
}

setbuf(stdout, nil) // ungepuffert - jede Zeile muss sofort raus, wie AutoFlush=true auf der PS1-Seite

print("{\"ready\":true}")

while let line = readLine(strippingNewline: true) {
  let trimmed = line.trimmingCharacters(in: .whitespaces)
  if trimmed.isEmpty { continue }
  guard let data = trimmed.data(using: .utf8),
        let req = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
    continue // fremde Zeile ignorieren, wie die PS1-Fassung
  }
  let id = req["id"]
  var resp: [String: Any]
  do {
    let result = try handleRequest(req)
    resp = ["id": id ?? NSNull(), "ok": true, "result": result]
  } catch let err as HelperError {
    resp = ["id": id ?? NSNull(), "ok": false, "error": err.message]
  } catch {
    resp = ["id": id ?? NSNull(), "ok": false, "error": "\(error)"]
  }
  if let out = try? JSONSerialization.data(withJSONObject: resp),
     let str = String(data: out, encoding: .utf8) {
    print(str)
  }
}
