#ifndef AppVersion
  #error AppVersion must be set by build-installer.ps1
#endif
#ifndef PublishDir
  #error PublishDir must be set by build-installer.ps1
#endif

[Setup]
AppId=SHOU-U-RUN.Windows
AppName=SHOU U RUN
AppVersion={#AppVersion}
AppPublisher=SHOU U RUN
AppPublisherURL=https://github.com/x-zyz/SHOU-U-RUN
DefaultDirName={autopf}\SHOU U RUN
DefaultGroupName=SHOU U RUN
DisableDirPage=auto
DisableProgramGroupPage=yes
PrivilegesRequired=admin
PrivilegesRequiredOverridesAllowed=commandline
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0.19041
OutputBaseFilename=SHOU-U-RUN-v{#AppVersion}-Windows-x64-Setup
SetupIconFile=app.ico
UninstallDisplayIcon={app}\app.ico
WizardStyle=modern
Compression=lzma2
SolidCompression=yes
RestartApplications=no

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"
Name: "chinesesimplified"; MessagesFile: "compiler:Languages\ChineseSimplified.isl"

[CustomMessages]
english.SelectEmptyDirectory=Choose a new or empty folder for SHOU U RUN.
chinesesimplified.SelectEmptyDirectory=请选择一个新建或空的文件夹来安装 SHOU U RUN。
english.KeepUpgradeDirectory=Install this update in the current SHOU U RUN folder. To change the location, uninstall the current version first.
chinesesimplified.KeepUpgradeDirectory=请将更新安装到现有目录。如需换目录，请先卸载当前版本。

[Files]
Source: "{#PublishDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"

[Icons]
Name: "{autoprograms}\SHOU U RUN"; Filename: "{app}\SHOU U RUN.exe"; WorkingDir: "{app}"; IconFilename: "{app}\app.ico"
Name: "{autodesktop}\SHOU U RUN"; Filename: "{app}\SHOU U RUN.exe"; WorkingDir: "{app}"; IconFilename: "{app}\app.ico"; Tasks: desktopicon

[Run]
Filename: "{app}\SHOU U RUN.exe"; Description: "{cm:LaunchProgram,SHOU U RUN}"; Flags: nowait postinstall skipifsilent

[Code]
function DirectoryError(const Target: String): String;
var
  PreviousDir: String;
  Entry: TFindRec;
begin
  Result := '';
  PreviousDir := GetPreviousData('InstallDir', '');
  if PreviousDir <> '' then
  begin
    if CompareText(RemoveBackslashUnlessRoot(PreviousDir), RemoveBackslashUnlessRoot(Target)) <> 0 then
      Result := CustomMessage('KeepUpgradeDirectory');
    Exit;
  end;

  if FindFirst(AddBackslash(Target) + '*', Entry) then
  begin
    try
      repeat
        if (Entry.Name <> '.') and (Entry.Name <> '..') then
        begin
          Result := CustomMessage('SelectEmptyDirectory');
          Exit;
        end;
      until not FindNext(Entry);
    finally
      FindClose(Entry);
    end;
  end;
end;

function NextButtonClick(CurPageID: Integer): Boolean;
var
  ErrorMessage: String;
begin
  Result := True;
  if CurPageID <> wpSelectDir then
    Exit;
  ErrorMessage := DirectoryError(WizardDirValue);
  if ErrorMessage <> '' then
  begin
    SuppressibleMsgBox(ErrorMessage, mbError, MB_OK, IDOK);
    Result := False;
  end;
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  Result := DirectoryError(WizardDirValue);
end;

procedure RegisterPreviousData(PreviousDataKey: Integer);
begin
  SetPreviousData(PreviousDataKey, 'InstallDir', ExpandConstant('{app}'));
end;
