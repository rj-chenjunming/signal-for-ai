' AI Signal - background launcher.
' Double-click to start with no console window.
' Closing any terminal/shell does NOT stop the app; quit from the tray icon.
Option Explicit

Dim sh, fso, root, code
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = root

On Error Resume Next
code = sh.Run("node.exe """ & root & "\scripts\start-desktop.mjs""", 0, True)
If Err.Number <> 0 Then
  MsgBox "Failed to start the Node.js launcher:" & vbCrLf & Err.Description & vbCrLf & vbCrLf & _
         "Install Node.js 24, or run the .cmd launcher to see details.", 16, "AI Signal"
  WScript.Quit 1
End If
On Error GoTo 0

If code <> 0 Then
  MsgBox "AI Signal failed to start (exit code " & code & ")." & vbCrLf & _
         "Run the .cmd launcher to see the error output.", 16, "AI Signal"
End If
