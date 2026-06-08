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

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; GroupDescription: "Shortcuts"
Name: "startup"; Description: "Start NekoBooru when Windows starts"; GroupDescription: "Startup"; Flags: unchecked
Name: "nativehost"; Description: "Install browser native host registration"; GroupDescription: "Browser integration"

[Files]
Source: "..\..\dist\nekobooru-binary\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\NekoBooru"; Filename: "{app}\{#MyAppExeName}"
Name: "{autodesktop}\NekoBooru"; Filename: "{app}\{#MyAppExeName}"; Tasks: desktopicon

[Registry]
Root: HKCU; Subkey: "Software\NekoBooru"; ValueType: string; ValueName: "InstallLocation"; ValueData: "{app}"; Flags: uninsdeletekey
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: string; ValueName: "NekoBooru"; ValueData: """{app}\{#MyAppExeName}"""; Tasks: startup; Flags: uninsdeletevalue

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "Launch NekoBooru"; Flags: nowait postinstall skipifsilent

[UninstallDelete]
; User data intentionally remains under %LOCALAPPDATA%\NekoBooru unless a future
; uninstall page explicitly asks to delete it.
Type: filesandordirs; Name: "{app}"
