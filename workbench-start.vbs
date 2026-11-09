' Arena workbench silent launcher: no console window, no browser, only the panel window.
Option Explicit
Dim sh, fso, root, rc
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
root = fso.GetParentFolderName(WScript.ScriptFullName)
rc = sh.Run("powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & root & "\app\start-local.ps1" & """", 0, True)
If rc <> 0 Then
  MsgBox "Panel failed to start (exit code " & rc & "). See app\.arena-gui\desktop-backend.log", 16, "Arena workbench"
End If
