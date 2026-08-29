@echo off
setlocal EnableExtensions

cd /d "%~dp0"
set "STOCKMASTER_ROOT=%CD%"
set "PYTHONUTF8=1"
set "STOCKMASTER_ENABLE_ALGORITHM_MONITOR=1"
set "STOCKMASTER_SYNC_DEV_UI=1"
if not defined STOCKMASTER_BUILD_UI set "STOCKMASTER_BUILD_UI=0"

echo [StockMaster] Checking Python...
where py >nul 2>nul
if errorlevel 1 (
  where python >nul 2>nul
  if errorlevel 1 goto :python_missing
  set "PYTHON_CMD=python"
) else (
  set "PYTHON_CMD=py -3"
)

echo [StockMaster] Checking Python dependencies...
%PYTHON_CMD% -c "import fake_useragent, sqlalchemy, efinance, newspaper" >nul 2>nul
if errorlevel 1 (
  echo [StockMaster] Python dependencies are incomplete. Installing requirements...
  %PYTHON_CMD% -m pip install -r "%STOCKMASTER_ROOT%\requirements.txt"
  if errorlevel 1 goto :python_dependencies_failed
)

if not exist "apps\dsa-web\node_modules" (
  echo [StockMaster] Installing Web dependencies...
  pushd "apps\dsa-web"
  call npm ci
  if errorlevel 1 goto :failed
  popd
)

if not exist "apps\dsa-desktop\node_modules" (
  echo [StockMaster] Installing desktop dependencies...
  pushd "apps\dsa-desktop"
  call npm ci
  if errorlevel 1 goto :failed
  popd
)

if not exist "apps\dsa-desktop\node_modules\electron\dist\electron.exe" (
  echo [StockMaster] Electron runtime is missing. Reinstalling Electron...
  pushd "apps\dsa-desktop"
  call npm rebuild electron --force
  if not exist "node_modules\electron\dist\electron.exe" goto :electron_missing
  popd
)

if /I "%STOCKMASTER_BUILD_UI%"=="1" call :build_ui

:start_desktop
echo [StockMaster] Starting desktop app. Close the Electron window to stop it.
pushd "apps\dsa-desktop"
call npm run dev
set "STOCKMASTER_EXIT=%ERRORLEVEL%"
popd
exit /b %STOCKMASTER_EXIT%

:build_ui
echo [StockMaster] Building Web UI...
pushd "%STOCKMASTER_ROOT%\apps\dsa-web"
if errorlevel 1 goto :failed
call npm run build
set "STOCKMASTER_BUILD_EXIT=%ERRORLEVEL%"
popd
if not "%STOCKMASTER_BUILD_EXIT%"=="0" exit /b %STOCKMASTER_BUILD_EXIT%
exit /b 0

:python_missing
echo [StockMaster] Python 3 was not found. Install Python 3.10+ and try again.
pause
exit /b 1

:python_dependencies_failed
echo [StockMaster] Python dependency installation failed. Check the output above and try again.
pause
exit /b 1

:electron_missing
echo [StockMaster] Electron runtime download failed. Check network access and run npm rebuild electron in apps\dsa-desktop.
pause
exit /b 1

:failed
echo [StockMaster] Startup preparation failed with code %ERRORLEVEL%.
pause
exit /b 1
