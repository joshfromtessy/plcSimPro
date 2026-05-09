@echo off
for /f "tokens=5" %%a in ('netstat -aon ^| findstr :5173 ^| findstr LISTENING') do (
  echo Killing PID %%a on port 5173...
  taskkill /f /pid %%a
)
echo Done.
timeout /t 2
