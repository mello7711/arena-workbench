' Arena watchdog silent keeper - never shows a window, never exits.
' Runs the watch loop; if the loop dies it starts it again after 5s.
Option Explicit
Dim shell, dir, rc
Set shell = CreateObject("WScript.Shell")
dir = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
Do
  rc = shell.Run("powershell.exe -NoProfile -ExecutionPolicy Bypass -File " & Chr(34) & dir & "\svc_ctl.ps1" & Chr(34) & " -Action watch -What all", 0, True)
  WScript.Sleep 5000
Loop
