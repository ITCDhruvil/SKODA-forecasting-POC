@echo off
cd /d "%~dp0dashboard"

if not exist node_modules (
  echo Installing dashboard dependencies...
  call npm install
  if errorlevel 1 exit /b 1
)

echo Starting the dashboard at http://localhost:5173
call npm run dev
