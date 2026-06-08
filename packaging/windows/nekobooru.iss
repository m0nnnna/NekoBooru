; NekoBooru Windows installer.
; Build after running build-binary.bat and installing Inno Setup.

#define MyAppName "NekoBooru"
#define MyAppVersion GetEnv("NEKOBOORU_VERSION")
#if MyAppVersion == ""
#define MyAppVersion "4.1.0"
#endif
#define MyAppPublisher "NekoBooru"
#define MyAppExeName "nekobooru.exe"

[Setup]
AppId={{9C17254D-1B7A-4C2E-9466-5F3A6C4D731B}}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
DefaultDirName={localappdata}\Programs\NekoBooru
DefaultGroupName=NekoBooru
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
OutputDir=..\..\dist\installer
OutputBaseFilename=NekoBooruSetup-{#MyAppVersion}
Compression=lzma
SolidCompression=yes
WizardStyle=modern
UninstallDisplayIcon={app}\{#MyAppExeName}
CloseApplications=no
RestartApplications=no

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; GroupDescription: "Shortcuts"
Name: "startup"; Description: "Start NekoBooru when Windows starts"; GroupDescription: "Startup"; Flags: unchecked
Name: "nativehost"; Description: "Install browser native host registration"; GroupDescription: "Browser integration"
Name: "forceairuntime"; Description: "Repair/reinstall selected AI runtime even if it already looks installed"; GroupDescription: "AI runtime"; Flags: unchecked

[Files]
Source: "..\..\dist\nekobooru-binary\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "apply-installer-settings.ps1"; DestDir: "{tmp}"; Flags: deleteafterinstall
Source: "..\..\install-ai.ps1"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\..\backend\requirements.txt"; DestDir: "{app}\backend"; Flags: ignoreversion
Source: "..\..\backend\requirements-tagger.txt"; DestDir: "{app}\backend"; Flags: ignoreversion
Source: "..\..\backend\requirements-tagger-cpu.txt"; DestDir: "{app}\backend"; Flags: ignoreversion
Source: "..\..\backend\requirements-tagger-legacy.txt"; DestDir: "{app}\backend"; Flags: ignoreversion
Source: "..\..\backend\*"; DestDir: "{app}\worker-backend"; Flags: ignoreversion recursesubdirs createallsubdirs; Excludes: "__pycache__\*,*.pyc"

[Icons]
Name: "{group}\NekoBooru"; Filename: "{app}\{#MyAppExeName}"
Name: "{autodesktop}\NekoBooru"; Filename: "{app}\{#MyAppExeName}"; Tasks: desktopicon

[Registry]
Root: HKCU; Subkey: "Software\NekoBooru"; ValueType: string; ValueName: "InstallLocation"; ValueData: "{app}"; Flags: uninsdeletekey
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: string; ValueName: "NekoBooru"; ValueData: """{app}\{#MyAppExeName}"""; Tasks: startup; Flags: uninsdeletevalue

[Run]
Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{tmp}\apply-installer-settings.ps1"" -BackendPort {code:GetBackendPort} -FrontendPort {code:GetFrontendPort} -AiProfile ""{code:GetAiProfile}"" -UpdateOwner ""{code:GetUpdateOwner}"" -UpdateRepo ""{code:GetUpdateRepo}"" -UpdateChannel ""{code:GetUpdateChannel}"""; Flags: runhidden waituntilterminated
Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\install-ai.ps1"" {code:GetAiInstallSwitch} {code:GetAiForceSwitch} -VenvPath ""{localappdata}\NekoBooru\runtimes\python-ai"" -ReceiptPath ""{localappdata}\NekoBooru\runtimes\python-ai\nekobooru-ai-runtime.json"" -LogPath ""{localappdata}\NekoBooru\logs\install-ai.log"""; StatusMsg: "Installing selected AI runtime. Detailed output is written to %LOCALAPPDATA%\NekoBooru\logs\install-ai.log."; Flags: runhidden waituntilterminated; Check: ShouldInstallLocalAi
Filename: "{app}\{#MyAppExeName}"; Description: "Launch NekoBooru"; Flags: nowait postinstall skipifsilent runhidden

[UninstallDelete]
; User data remains under %LOCALAPPDATA%\NekoBooru unless the uninstall code
; below explicitly asks for and receives cleanup confirmation.
Type: filesandordirs; Name: "{app}"

[Code]
var
  PortPage: TInputQueryWizardPage;
  AiPage: TInputOptionWizardPage;
  UpdatePage: TInputQueryWizardPage;
  UninstallDeleteAllUserData: Boolean;
  UninstallDeleteAiRuntime: Boolean;
  UninstallDeleteModels: Boolean;

function PsSingleQuote(Value: String): String;
begin
  StringChangeEx(Value, '''', '''''', True);
  Result := '''' + Value + '''';
end;

procedure SignalNekoBooruShutdown;
var
  ResultCode: Integer;
begin
  Exec(
    'powershell.exe',
    '-NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference=''SilentlyContinue''; ' +
      'try { $e=[System.Threading.EventWaitHandle]::OpenExisting(''Local\NekoBooruShutdown''); ' +
      '$e.Set() | Out-Null; $e.Dispose() } catch { }"',
    '',
    SW_HIDE,
    ewWaitUntilTerminated,
    ResultCode
  );
end;

function IsInstalledNekoBooruRunning: Boolean;
var
  ResultCode: Integer;
  TargetExe: String;
begin
  TargetExe := ExpandConstant('{app}\{#MyAppExeName}');
  Exec(
    'powershell.exe',
    '-NoProfile -ExecutionPolicy Bypass -Command "$target=[System.IO.Path]::GetFullPath(' + PsSingleQuote(TargetExe) + '); ' +
      '$found=$false; ' +
      'Get-Process -Name ''nekobooru'' -ErrorAction SilentlyContinue | ForEach-Object { ' +
      'try { if ($_.Path -and ([System.IO.Path]::GetFullPath($_.Path) -ieq $target)) { $found=$true } } catch { } }; ' +
      'if (-not $found) { Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.Name -ieq ''nekobooru.exe'' } | ForEach-Object { ' +
      'try { if ($_.ExecutablePath -and ([System.IO.Path]::GetFullPath($_.ExecutablePath) -ieq $target)) { $found=$true } } catch { } } }; ' +
      'if ($found) { exit 0 } else { exit 1 }"',
    '',
    SW_HIDE,
    ewWaitUntilTerminated,
    ResultCode
  );
  Result := ResultCode = 0;
end;

procedure ForceStopInstalledNekoBooru;
var
  ResultCode: Integer;
  TargetExe: String;
begin
  TargetExe := ExpandConstant('{app}\{#MyAppExeName}');
  Exec(
    'powershell.exe',
    '-NoProfile -ExecutionPolicy Bypass -Command "$target=[System.IO.Path]::GetFullPath(' + PsSingleQuote(TargetExe) + '); ' +
      '$ids=@(); ' +
      'Get-Process -Name ''nekobooru'' -ErrorAction SilentlyContinue | ForEach-Object { ' +
      'try { if ($_.Path -and ([System.IO.Path]::GetFullPath($_.Path) -ieq $target)) { $ids += [int]$_.Id } } catch { } }; ' +
      'Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.Name -ieq ''nekobooru.exe'' } | ForEach-Object { ' +
      'try { if ($_.ExecutablePath -and ([System.IO.Path]::GetFullPath($_.ExecutablePath) -ieq $target)) { $ids += [int]$_.ProcessId } } catch { } }; ' +
      '$ids | Select-Object -Unique | ForEach-Object { try { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue } catch { } }"',
    '',
    SW_HIDE,
    ewWaitUntilTerminated,
    ResultCode
  );
end;

procedure ShutDownRunningNekoBooru;
var
  I: Integer;
begin
  SignalNekoBooruShutdown;
  for I := 1 to 10 do
  begin
    if not IsInstalledNekoBooruRunning then
      Exit;
    Sleep(500);
  end;

  ForceStopInstalledNekoBooru;
  for I := 1 to 10 do
  begin
    if not IsInstalledNekoBooruRunning then
      Exit;
    Sleep(500);
  end;

  if not IsInstalledNekoBooruRunning then
    Exit;

  if MsgBox(
    'NekoBooru is still running and must be closed before setup can continue.' + #13#10 + #13#10 +
    'Choose Yes to shut down the installed NekoBooru app now.',
    mbConfirmation,
    MB_YESNO
  ) <> IDYES then
    Abort;

  ForceStopInstalledNekoBooru;
  for I := 1 to 10 do
  begin
    if not IsInstalledNekoBooruRunning then
      Exit;
    Sleep(500);
  end;

  MsgBox('NekoBooru is still running. Shut it down from the tray menu, then run setup again.', mbError, MB_OK);
  Abort;
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  ShutDownRunningNekoBooru;
  Result := '';
end;

procedure InitializeWizard;
begin
  PortPage :=
    CreateInputQueryPage(
      wpSelectDir,
      'Configure Local Ports',
      'Choose the local ports NekoBooru should use.',
      'The backend serves the packaged web UI and API. The dev/CORS port only allows an optional Vite frontend during debugging.'
    );
  PortPage.Add('Backend/API port:', False);
  PortPage.Add('Dev frontend/CORS port:', False);
  PortPage.Values[0] := '8773';
  PortPage.Values[1] := '5174';

  AiPage :=
    CreateInputOptionPage(
      PortPage.ID,
      'Choose AI Runtime Setup',
      'Select how NekoBooru should prepare AI tagging.',
      'Local CPU/GPU choices install the selected Torch/ONNX/Transformers runtime during setup. Model weights are still downloaded from NekoBooru Settings so you can choose exactly which taggers to keep locally.',
      True,
      False
    );
  AiPage.Add('Skip AI setup for now');
  AiPage.Add('Local CPU AI - easiest install, slower tagging (~3-5 GB download, 0 GB VRAM)');
  AiPage.Add('Local NVIDIA GPU AI - RTX/modern CUDA desktops (~6-8 GB CUDA/Torch runtime download)');
  AiPage.Add('Local legacy NVIDIA GPU AI - CUDA 12.6/Pascal compatibility (~6-8 GB runtime download)');
  AiPage.Add('Remote/server AI - use another GPU machine (no local CUDA runtime download)');
  AiPage.SelectedValueIndex := 0;

  UpdatePage :=
    CreateInputQueryPage(
      AiPage.ID,
      'Configure Update Source',
      'Choose where installed NekoBooru checks for release binaries.',
      'By default, updates use upstream GitHub Releases. To test your fork, change the owner to your GitHub username or organization. The app should download release assets, not temporary Actions artifacts.'
    );
  UpdatePage.Add('GitHub owner:', False);
  UpdatePage.Add('GitHub repository:', False);
  UpdatePage.Add('Update channel (stable, prerelease, off):', False);
  UpdatePage.Values[0] := 'm0nnnna';
  UpdatePage.Values[1] := 'NekoBooru';
  UpdatePage.Values[2] := 'stable';
end;

function IsDigits(Value: String): Boolean;
var
  I: Integer;
begin
  Result := Value <> '';
  for I := 1 to Length(Value) do
  begin
    if (Value[I] < '0') or (Value[I] > '9') then
    begin
      Result := False;
      Exit;
    end;
  end;
end;

function IsValidPort(Value: String): Boolean;
var
  Port: Integer;
begin
  Result := False;
  if not IsDigits(Value) then
    Exit;
  Port := StrToInt(Value);
  Result := (Port >= 1024) and (Port <= 65535);
end;

function NextButtonClick(CurPageID: Integer): Boolean;
begin
  Result := True;
  if CurPageID = PortPage.ID then
  begin
    if not IsValidPort(PortPage.Values[0]) then
    begin
      MsgBox('Backend/API port must be a number from 1024 to 65535.', mbError, MB_OK);
      Result := False;
      Exit;
    end;
    if not IsValidPort(PortPage.Values[1]) then
    begin
      MsgBox('Dev frontend/CORS port must be a number from 1024 to 65535.', mbError, MB_OK);
      Result := False;
      Exit;
    end;
    if PortPage.Values[0] = PortPage.Values[1] then
    begin
      MsgBox('Backend/API port and dev frontend/CORS port must be different.', mbError, MB_OK);
      Result := False;
      Exit;
    end;
  end;
  if CurPageID = UpdatePage.ID then
  begin
    if (Trim(UpdatePage.Values[0]) = '') or (Trim(UpdatePage.Values[1]) = '') then
    begin
      MsgBox('Update owner and repository are required. Use m0nnnna / NekoBooru for upstream releases.', mbError, MB_OK);
      Result := False;
      Exit;
    end;
    if (Lowercase(Trim(UpdatePage.Values[2])) <> 'stable') and
       (Lowercase(Trim(UpdatePage.Values[2])) <> 'prerelease') and
       (Lowercase(Trim(UpdatePage.Values[2])) <> 'off') then
    begin
      MsgBox('Update channel must be stable, prerelease, or off.', mbError, MB_OK);
      Result := False;
      Exit;
    end;
  end;
end;

function GetBackendPort(Param: String): String;
begin
  Result := PortPage.Values[0];
end;

function GetFrontendPort(Param: String): String;
begin
  Result := PortPage.Values[1];
end;

function GetAiProfile(Param: String): String;
begin
  case AiPage.SelectedValueIndex of
    1: Result := 'cpu';
    2: Result := 'gpu-cu128';
    3: Result := 'gpu-cu126-legacy';
    4: Result := 'remote';
  else
    Result := 'skip';
  end;
end;

function GetAiInstallSwitch(Param: String): String;
begin
  case AiPage.SelectedValueIndex of
    1: Result := '-CPU';
    2: Result := '-GPU';
    3: Result := '-Legacy';
  else
    Result := '';
  end;
end;

function GetAiForceSwitch(Param: String): String;
begin
  if WizardIsTaskSelected('forceairuntime') then
    Result := '-Force'
  else
    Result := '';
end;

function ShouldInstallLocalAi(): Boolean;
begin
  Result := (AiPage.SelectedValueIndex >= 1) and (AiPage.SelectedValueIndex <= 3);
end;

function GetUpdateOwner(Param: String): String;
begin
  Result := Trim(UpdatePage.Values[0]);
end;

function GetUpdateRepo(Param: String): String;
begin
  Result := Trim(UpdatePage.Values[1]);
end;

function GetUpdateChannel(Param: String): String;
begin
  Result := Lowercase(Trim(UpdatePage.Values[2]));
end;

function InitializeUninstall(): Boolean;
begin
  Result := True;
  UninstallDeleteAllUserData := False;
  UninstallDeleteAiRuntime := False;
  UninstallDeleteModels := False;

  if UninstallSilent then
    Exit;

  if MsgBox(
    'NekoBooru can keep your posts, settings, logs, downloaded model weights, and optional AI runtime after uninstall.' + #13#10 + #13#10 +
    'Choose Yes to review optional cleanup choices. Choose No to remove only the installed app files.',
    mbConfirmation,
    MB_YESNO
  ) <> IDYES then
    Exit;

  if MsgBox(
    'Delete ALL NekoBooru user data under:' + #13#10 +
    ExpandConstant('{localappdata}\NekoBooru') + #13#10 + #13#10 +
    'This removes posts/database, settings, logs, downloaded model weights, and the AI runtime. This cannot be undone.',
    mbCriticalError,
    MB_YESNO
  ) = IDYES then
  begin
    UninstallDeleteAllUserData := True;
    Exit;
  end;

  UninstallDeleteAiRuntime :=
    MsgBox(
      'Delete the optional AI runtime, including Torch/CUDA Python wheels, under:' + #13#10 +
      ExpandConstant('{localappdata}\NekoBooru\runtimes\python-ai') + #13#10 + #13#10 +
      'This keeps your posts, settings, and downloaded model weights.',
      mbConfirmation,
      MB_YESNO
    ) = IDYES;

  UninstallDeleteModels :=
    MsgBox(
      'Delete downloaded AI model weights under:' + #13#10 +
      ExpandConstant('{localappdata}\NekoBooru\models') + #13#10 + #13#10 +
      'This keeps your posts, settings, and AI runtime.',
      mbConfirmation,
      MB_YESNO
    ) = IDYES;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if CurUninstallStep = usUninstall then
  begin
    ShutDownRunningNekoBooru;
    Exit;
  end;

  if CurUninstallStep <> usPostUninstall then
    Exit;

  if UninstallDeleteAllUserData then
  begin
    DelTree(ExpandConstant('{localappdata}\NekoBooru'), True, True, True);
    Exit;
  end;

  if UninstallDeleteAiRuntime then
  begin
    DelTree(ExpandConstant('{localappdata}\NekoBooru\runtimes\python-ai'), True, True, True);
  end;

  if UninstallDeleteModels then
  begin
    DelTree(ExpandConstant('{localappdata}\NekoBooru\models'), True, True, True);
  end;
end;
