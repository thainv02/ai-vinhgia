; Bộ cài Windows của AI Vinh Gia (Inno Setup 6.5+). Dựng bằng `npm run build:installer` (scripts/build-installer.mjs),
; cần có sẵn src-tauri\target\release\autovideo.exe (`tauri build --no-bundle`) và dist-win\ (`npm run build:win`);
; script tự tải model nhận dạng lời nói vào .build-cache\stt-models (kiểm SHA256) để đóng vào bộ cài.
;
; Cài mới theo user: %LOCALAPPDATA%\Programs\AI Vinh Gia\AI Vinh Gia.exe + runtime\; cập nhật giữ đường dẫn cài cũ.
; Ngoài thư mục cài (cập nhật không mất):
;   %LOCALAPPDATA%\vn.syntra.autovideo   model nhận dạng lời nói (models\, bộ cài chép sẵn) + dữ liệu WebView2
;   %APPDATA%\AutoVideo\settings.json    đường dẫn thư mục dữ liệu do người dùng chọn ở lần chạy đầu
;   thư mục dữ liệu (dự án, video, DB)   KHÔNG BAO GIỜ bị bộ cài/gỡ cài xoá
; Gỡ cài đặt chỉ xoá cài đặt + model khi người dùng đồng ý; gỡ im lặng (/SILENT) giữ nguyên.

#define AppName "AI Vinh Gia"
#define AppPublisher "Vinh Gia"
#define AppExeName "AI Vinh Gia.exe"
#define LegacyAppName "AutoVideo"
#define LegacyAppExeName "AutoVideo.exe"
#define BundleId "vn.syntra.autovideo"
#define AppBin SourcePath + "..\src-tauri\target\release\autovideo.exe"
#ifndef AppVersion
  #define AppVersion GetVersionNumbersString(AppBin)
#endif

[Setup]
; AppId cố định: đổi là Windows coi như app khác, cập nhật không đè được bản cũ.
AppId={{1758C619-EBE5-425F-A432-1A787CAE650C}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher={#AppPublisher}
VersionInfoVersion={#AppVersion}
VersionInfoProductName={#AppName}
DefaultDirName={autopf}\{#AppName}
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=commandline
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
; WebView2 cần Windows 10 1809 trở lên.
MinVersion=10.0.17763
OutputDir=..\src-tauri\target\release\bundle\inno
OutputBaseFilename={#AppName}_{#AppVersion}_x64-setup
SetupIconFile=..\src-tauri\icons\icon.ico
UninstallDisplayIcon={app}\{#AppExeName}
UninstallDisplayName={#AppName}
WizardStyle=modern
Compression=lzma2/max
SolidCompression=yes
SetupMutex=AutoVideoSetup,Global\AutoVideoSetup
; Tiến trình đang chạy do [Code] tự đóng (CloseAppIn); Restart Manager chỉ là lớp dự phòng.
CloseApplications=yes
RestartApplications=no
ShowLanguageDialog=no

[Languages]
Name: "vi"; MessagesFile: "Vietnamese.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"

[InstallDelete]
; Runtime là bản build nguyên khối: xoá bản cũ để không sót file thừa (node_modules, script đã bỏ) khi cập nhật.
Type: filesandordirs; Name: "{app}\runtime"
; Đổi thương hiệu nhưng giữ AppId/data: dọn exe và shortcut tên cũ sau khi CloseAppIn đã dừng app.
Type: files; Name: "{app}\{#LegacyAppExeName}"
Type: files; Name: "{autoprograms}\{#LegacyAppName}.lnk"
Type: files; Name: "{autodesktop}\{#LegacyAppName}.lnk"

[Files]
Source: "{#AppBin}"; DestDir: "{app}"; DestName: "{#AppExeName}"; Flags: ignoreversion
Source: "..\dist-win\*"; DestDir: "{app}\runtime"; Flags: ignoreversion recursesubdirs createallsubdirs
; Model nhận dạng lời nói (~73 MB) chép thẳng vào chỗ app đọc nên không phải tải từ HuggingFace lúc cài (hay bị HTTP 429).
; Nằm ngoài {app} để cập nhật không mất; uninsneveruninstall vì gỡ cài chỉ xoá model khi người dùng đồng ý (CurUninstallStepChanged).
Source: "..\.build-cache\stt-models\*"; DestDir: "{localappdata}\{#BundleId}\models"; Flags: ignoreversion recursesubdirs createallsubdirs uninsneveruninstall

[Icons]
; AppUserModelID trùng identifier của Tauri để cửa sổ gộp đúng vào shortcut trên taskbar.
Name: "{autoprograms}\{#AppName}"; Filename: "{app}\{#AppExeName}"; AppUserModelID: "{#BundleId}"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\{#AppExeName}"; AppUserModelID: "{#BundleId}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#AppExeName}"; Description: "{cm:LaunchProgram,{#AppName}}"; Flags: nowait postinstall skipifsilent

[UninstallDelete]
; File sinh ra lúc chạy trong runtime\ (không do bộ cài chép) cũng phải đi theo.
Type: filesandordirs; Name: "{app}\runtime"
Type: dirifempty; Name: "{app}"

[Code]
const
  WebView2ClientKey = 'Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}';
  WebView2BootstrapperUrl = 'https://go.microsoft.com/fwlink/p/?LinkId=2124703';
  { Bản cài NSIS cũ của Tauri (trước khi chuyển sang Inno Setup). }
  LegacyUninstallKey = 'Software\Microsoft\Windows\CurrentVersion\Uninstall\{#LegacyAppName}';

type
  TPidArray = array of Integer;

function WqlString(const S: String): String;
begin
  Result := S;
  StringChangeEx(Result, '\', '\\', True);
  StringChangeEx(Result, '''', '\''', True);
end;

function WqlLikePrefix(const S: String): String;
begin
  Result := WqlString(S);
  StringChangeEx(Result, '[', '[[]', True);
  StringChangeEx(Result, '_', '[_]', True);
end;

{ Tiến trình của bản cài ở Dir: AutoVideo.exe và mọi thứ chạy từ runtime\ (server, worker node.exe, ffmpeg).
  Lọc theo đường dẫn exe nên không đụng tới node.exe/ffmpeg khác trên máy. }
function FindAppProcesses(const Dir: String): TPidArray;
var
  Locator, Wmi, Procs: Variant;
  D: String;
  I: Integer;
begin
  SetArrayLength(Result, 0);
  if (Dir = '') or not DirExists(Dir) then
    Exit;
  D := RemoveBackslashUnlessRoot(Dir);
  try
    Locator := CreateOleObject('WbemScripting.SWbemLocator');
    Wmi := Locator.ConnectServer('.', 'root\CIMV2');
    Procs := Wmi.ExecQuery('SELECT ProcessId FROM Win32_Process WHERE ExecutablePath = ''' +
      WqlString(D + '\{#AppExeName}') + ''' OR ExecutablePath = ''' +
      WqlString(D + '\{#LegacyAppExeName}') + ''' OR ExecutablePath LIKE ''' + WqlLikePrefix(D + '\runtime\') + '%''');
    SetArrayLength(Result, Procs.Count);
    for I := 0 to Procs.Count - 1 do
      Result[I] := Procs.ItemIndex(I).ProcessId;
  except
    Log('Không liệt kê được tiến trình: ' + GetExceptionMessage);
  end;
end;

procedure TaskKill(const Pids: TPidArray; const Force: Boolean);
var
  I, RC: Integer;
  Args: String;
begin
  for I := 0 to GetArrayLength(Pids) - 1 do
  begin
    Args := '/PID ' + IntToStr(Pids[I]);
    if Force then
      Args := '/F /T ' + Args;
    Exec(ExpandConstant('{sys}\taskkill.exe'), Args, '', SW_HIDE, ewWaitUntilTerminated, RC);
  end;
end;

{ Đóng AutoVideo đang chạy từ Dir. Gửi đóng cửa sổ trước để app tắt server gọn (huỷ việc đang chạy, đóng DB),
  quá 10 giây mới kill cả cây. False = người dùng không đồng ý hoặc không đóng được. }
function CloseAppIn(const Dir: String; const Ask: Boolean): Boolean;
var
  Tries: Integer;
begin
  Result := True;
  if GetArrayLength(FindAppProcesses(Dir)) = 0 then
    Exit;
  if Ask and (MsgBox('AI Vinh Gia đang chạy. Bấm OK để đóng AI Vinh Gia và tiếp tục (việc đang chạy trong app sẽ dừng).',
    mbConfirmation, MB_OKCANCEL) <> IDOK) then
  begin
    Result := False;
    Exit;
  end;
  TaskKill(FindAppProcesses(Dir), False);
  for Tries := 1 to 20 do
  begin
    Sleep(500);
    if GetArrayLength(FindAppProcesses(Dir)) = 0 then
      Exit;
  end;
  TaskKill(FindAppProcesses(Dir), True);
  Sleep(1000);
  Result := GetArrayLength(FindAppProcesses(Dir)) = 0;
end;

{ Gỡ bản NSIS cũ (khác AppId, khác thư mục) để máy không có hai bản AutoVideo. '' = xong. }
function UninstallLegacyNsis: String;
var
  Uninstaller, Dir: String;
  RC: Integer;
begin
  Result := '';
  if not RegQueryStringValue(HKCU, LegacyUninstallKey, 'UninstallString', Uninstaller) then
    Exit;
  Uninstaller := RemoveQuotes(Uninstaller);
  Dir := ExtractFileDir(Uninstaller);
  if not FileExists(Uninstaller) then
  begin
    RegDeleteKeyIncludingSubkeys(HKCU, LegacyUninstallKey);
    Exit;
  end;
  if not CloseAppIn(Dir, not WizardSilent) then
  begin
    Result := 'Hãy đóng AI Vinh Gia rồi chạy lại bộ cài.';
    Exit;
  end;
  Log('Gỡ bản NSIS cũ: ' + Dir);
  { _?= chạy uninstaller tại chỗ và chờ nó xong (không tự chép sang %TEMP% rồi thoát ngay). }
  if not Exec(Uninstaller, '/S _?=' + Dir, '', SW_HIDE, ewWaitUntilTerminated, RC) or (RC <> 0) then
  begin
    Result := 'Không gỡ được bản AutoVideo cũ ở ' + Dir + '. Hãy gỡ nó trong Settings > Apps rồi chạy lại bộ cài.';
    Exit;
  end;
  DeleteFile(Uninstaller);
  RemoveDir(Dir);
end;

function WebView2Version(const RootKey: Integer; const SubKey: String): String;
begin
  if not RegQueryStringValue(RootKey, SubKey, 'pv', Result) or (Result = '0.0.0.0') then
    Result := '';
end;

function WebView2Installed: Boolean;
begin
  Result := (WebView2Version(HKLM32, 'SOFTWARE\' + WebView2ClientKey) <> '') or
    (WebView2Version(HKCU, 'Software\' + WebView2ClientKey) <> '');
end;

{ Win10/11 thường có sẵn WebView2; máy nào thiếu thì tải bootstrapper của Microsoft (~2 MB) và cài theo user. }
function InstallWebView2: String;
var
  RC: Integer;
begin
  Result := '';
  if WebView2Installed then
    Exit;
  Log('Chưa có WebView2 Runtime, tải bootstrapper');
  try
    DownloadTemporaryFile(WebView2BootstrapperUrl, 'MicrosoftEdgeWebview2Setup.exe', '', nil);
  except
    Result := 'Máy chưa có Microsoft Edge WebView2 Runtime (AI Vinh Gia cần nó để hiển thị giao diện) và không tải được bộ cài: ' +
      GetExceptionMessage + #13#10#13#10 + 'Kiểm tra kết nối internet rồi chạy lại bộ cài.';
    Exit;
  end;
  if not Exec(ExpandConstant('{tmp}\MicrosoftEdgeWebview2Setup.exe'), '/silent /install', '', SW_HIDE,
    ewWaitUntilTerminated, RC) or not WebView2Installed then
    Result := 'Cài Microsoft Edge WebView2 Runtime không thành công (mã ' + IntToStr(RC) + '). ' +
      'Tải thủ công tại https://developer.microsoft.com/microsoft-edge/webview2/ rồi chạy lại bộ cài.';
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  if not CloseAppIn(ExpandConstant('{app}'), not WizardSilent) then
  begin
    Result := 'Hãy đóng AI Vinh Gia rồi chạy lại bộ cài.';
    Exit;
  end;
  Result := UninstallLegacyNsis;
  if Result = '' then
    Result := InstallWebView2;
end;

function InitializeUninstall: Boolean;
begin
  Result := CloseAppIn(ExpandConstant('{app}'), not UninstallSilent);
  if not Result and not UninstallSilent then
    MsgBox('Hãy đóng AI Vinh Gia rồi gỡ cài đặt lại.', mbError, MB_OK);
end;

{ Thư mục dữ liệu đã lưu trong settings.json (src-tauri/src/settings.rs). Đường dẫn có ký tự ngoài ASCII
  thì trả '' (không tự giải mã UTF-8) và thông báo dùng câu chung. }
function SavedDataDir: String;
var
  Raw: AnsiString;
  S: String;
  I, P: Integer;
begin
  Result := '';
  if not LoadStringFromFile(ExpandConstant('{userappdata}\AutoVideo\settings.json'), Raw) then
    Exit;
  for I := 1 to Length(Raw) do
    if Ord(Raw[I]) > 127 then
      Exit;
  S := String(Raw);
  P := Pos('"dataDir"', S);
  if P = 0 then
    Exit;
  Delete(S, 1, P + Length('"dataDir"') - 1);
  P := Pos('"', S);
  if P = 0 then
    Exit;
  Delete(S, 1, P);
  P := Pos('"', S);
  if P = 0 then
    Exit;
  Result := Copy(S, 1, P - 1);
  StringChangeEx(Result, '\\', '\', True);
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  DataDir, Where: String;
begin
  if (CurUninstallStep <> usPostUninstall) or UninstallSilent then
    Exit;
  DataDir := SavedDataDir;
  if DataDir <> '' then
    Where := 'thư mục dữ liệu:' + #13#10 + DataDir
  else
    Where := 'thư mục dữ liệu bạn đã chọn khi mở AI Vinh Gia lần đầu';
  if MsgBox('Đã gỡ AI Vinh Gia.' + #13#10#13#10 +
    'Dự án, video và cấu hình vẫn được giữ nguyên trong ' + Where + #13#10 +
    'Muốn xoá thì tự xoá thư mục đó.' + #13#10#13#10 +
    'Xoá luôn cài đặt của app và model nhận dạng lời nói (khoảng 73 MB)? ' +
    'Nếu cài lại sẽ phải chọn lại thư mục dữ liệu.',
    mbConfirmation, MB_YESNO or MB_DEFBUTTON2) = IDYES then
  begin
    DelTree(ExpandConstant('{localappdata}\{#BundleId}'), True, True, True);
    DelTree(ExpandConstant('{userappdata}\{#BundleId}'), True, True, True);
    DelTree(ExpandConstant('{userappdata}\AutoVideo'), True, True, True);
  end;
end;
