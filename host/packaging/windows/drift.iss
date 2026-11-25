; Inno Setup script for the Windows installer around the packaged drift-host (scripts/build-host.sh first).
; Built by scripts/build-installer.sh, which sets these environment variables. Per user, no admin rights:
; installs to %LOCALAPPDATA%\Programs\drift and registers drift-host with every Chromium browser (HKCU).
; Signing (unsigned until secrets exist): build-installer.sh passes /S with a sign tool when one is configured.
#define AppVersion GetEnv("DRIFT_VERSION")
#define AppVersionNumber GetEnv("DRIFT_VERSION_NUMBER")
#define ExtensionId GetEnv("DRIFT_EXTENSION_ID")
#define HostDist GetEnv("DRIFT_HOST_DIST")
#define OutputDir GetEnv("DRIFT_OUTPUT")
#define RootDir GetEnv("DRIFT_ROOT")

[Setup]
AppId={{BEE7CC80-B08D-4DED-94D8-07C8B0A0C19E}
AppName=drift
AppVersion={#AppVersion}
AppVerName=drift-host {#AppVersion}
VersionInfoVersion={#AppVersionNumber}
AppPublisher=drift
AppPublisherURL=https://github.com/Alex-Fix/drift
AppSupportURL=https://github.com/Alex-Fix/drift/issues
DefaultDirName={localappdata}\Programs\drift
PrivilegesRequired=lowest
DisableDirPage=yes
DisableProgramGroupPage=yes
OutputDir={#OutputDir}
OutputBaseFilename=drift-host-{#AppVersion}-windows-x64-setup
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
LicenseFile={#RootDir}\LICENSE
SetupIconFile={#RootDir}\host\packaging\windows\drift.ico
UninstallDisplayIcon={app}\drift-host\drift-host.exe
UninstallDisplayName=drift-host

[InstallDelete]
; A clean upgrade: no files left over from the previous version.
Type: filesandordirs; Name: "{app}\drift-host"

[Files]
Source: "{#HostDist}\*"; DestDir: "{app}\drift-host"; Flags: recursesubdirs ignoreversion

[Run]
Filename: "{app}\drift-host\drift-host.exe"; Parameters: "install --extension-id {#ExtensionId}"; Flags: runhidden waituntilterminated; StatusMsg: "Registering drift-host with your browsers..."

[UninstallRun]
Filename: "{app}\drift-host\drift-host.exe"; Parameters: "uninstall --extension-id {#ExtensionId}"; Flags: runhidden waituntilterminated; RunOnceId: "UnregisterHost"

[UninstallDelete]
Type: filesandordirs; Name: "{app}\drift-host"

[Messages]
FinishedLabel=drift-host is installed. Open your browser and click the drift icon (reload the extension once if it was open).
