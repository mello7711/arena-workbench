' Arena silent autostart launcher (no console window).
' IMPORTANT: use -Action watch, NOT start.
' So the watchdog loop runs from boot; services restart themselves,
' no longer depending on the scheduled task logon trigger timing.
Option Explicit
Dim shell, dir
Set shell = CreateObject("WScript.Shell")
dir = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
shell.Run "powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File " & Chr(34) & dir & "\svc_ctl.ps1" & Chr(34) & " -Action watch -What all", 0, False
Set shell = Nothing
