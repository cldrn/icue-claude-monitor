' Launches "<exe>" "<script>" with no console window. Used by the icue-claude-monitor scheduled task.
Set sh = CreateObject("WScript.Shell")
sh.Run """" & WScript.Arguments(0) & """ """ & WScript.Arguments(1) & """", 0, False
