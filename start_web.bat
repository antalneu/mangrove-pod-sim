@echo off
REM Launch the Mangrove Pod simulation web app, then open it in your browser.
cd /d "%~dp0"
echo Starting the Mangrove Pod simulator on http://127.0.0.1:5000 ...
start "" http://127.0.0.1:5000
".venv\Scripts\python.exe" webapp\app.py
pause
