' Launch a PowerShell script with no visible console window.
'
' PowerShell's own -WindowStyle Hidden still flashes a console on startup when
' run from a scheduled task. Going through wscript avoids that entirely.
'
' Usage from a scheduled task action:
'   Program:   C:\Windows\System32\wscript.exe
'   Arguments: //B //NoLogo "C:\path\to\run-hidden.vbs" "C:\path\to\supervisor.ps1"
'
' SPDX-License-Identifier: MIT

Option Explicit

Dim shell, scriptPath, command

If WScript.Arguments.Count < 1 Then
    WScript.Quit 2
End If

scriptPath = WScript.Arguments(0)

command = "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File """ & scriptPath & """"

Set shell = CreateObject("WScript.Shell")

' 0 = hidden window, True = wait for it to exit.
' Waiting keeps the scheduled task in the Running state for as long as the
' supervisor lives, which is what makes "task is Running" a meaningful signal.
shell.Run command, 0, True
