@echo off
REM ===========================================================================
REM installers\install_windows.cmd
REM Double-Click Windows Bootstrap Wrapper for installers\install_windows.ps1
REM ===========================================================================
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install_windows.ps1" %*
