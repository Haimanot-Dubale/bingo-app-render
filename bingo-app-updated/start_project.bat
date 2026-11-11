@echo off
:: 1. Start XAMPP MySQL cleanly in the background as a standalone task
echo Starting XAMPP MySQL Database...
start /b "" "C:\xampp\mysql\bin\mysqld.exe" --defaults-file="C:\xampp\mysql\bin\my.ini" --standalone

:: 2. Increase initialization timeout to 10 seconds to ensure port 3306 is bound properly
echo Waiting for MySQL to initialize...
timeout /t 10 /nobreak > nul

:: 3. Navigate to your specific Bingo app workspace
cd /d "C:\users\hp user\desktop\Apps\bingo copy\bingo-app"

:: 4. Launch npm start safely in the background
echo Starting Bingo App in the background...
start /b cmd /c npm start

:: 5. Wait for the Node.js server to cache resources, then open the UI
timeout /t 5 /nobreak > nul
echo Opening Bingo App in browser...
start http://localhost:3000

echo.
echo ================================================
echo Success! MySQL and Bingo App are running.
echo ================================================
timeout /t 3
exit