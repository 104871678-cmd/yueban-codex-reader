param([string]$InitialDirectory = [string]::Empty, [long]$OwnerWindow = 0)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
Add-Type -AssemblyName System.Windows.Forms
Add-Type -ReferencedAssemblies System.Windows.Forms -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
using System.Windows.Forms;
public sealed class ReaderPickerWindow : IWin32Window {
    public IntPtr Handle { get; private set; }
    public ReaderPickerWindow(IntPtr handle) { Handle = handle; }
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern IntPtr GetLastActivePopup(IntPtr window);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr window);
    [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr window, IntPtr after, int x, int y, int cx, int cy, uint flags);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] private static extern int GetWindowText(IntPtr window, StringBuilder text, int count);
    public static ReaderPickerWindow CurrentReader() {
        IntPtr handle = GetForegroundWindow();
        var title = new StringBuilder(1024);
        GetWindowText(handle, title, title.Capacity);
        string value = title.ToString();
        return value.Contains("Codex Reader") || value.Contains("\u9605\u4f34") ? new ReaderPickerWindow(handle) : null;
    }
}
'@
$dialog = New-Object System.Windows.Forms.OpenFileDialog
$fallbackOwner = $null
$frontTimer = $null
try {
    $dialog.Title = '打开文档 · 阅伴'
    $dialog.Filter = '课程文档 (*.pdf;*.ppt;*.pptx;*.html;*.htm)|*.pdf;*.ppt;*.pptx;*.html;*.htm'
    $dialog.CheckFileExists = $true
    $dialog.Multiselect = $false
    $dialog.RestoreDirectory = $true
    if ($InitialDirectory -and [IO.Directory]::Exists($InitialDirectory)) { $dialog.InitialDirectory = $InitialDirectory }
    # The actual reader HWND keeps the native dialog above its browser window.
    $owner = if ($OwnerWindow) { [ReaderPickerWindow]::new([IntPtr]::new($OwnerWindow)) } else { [ReaderPickerWindow]::CurrentReader() }
    if (-not $owner) {
        # A never-shown Form has no usable foreground position. Show a transparent
        # tool window first when the reader HWND is unavailable.
        $fallbackOwner = New-Object System.Windows.Forms.Form
        $fallbackOwner.TopMost = $true
        $fallbackOwner.ShowInTaskbar = $false
        $fallbackOwner.FormBorderStyle = 'None'
        $fallbackOwner.Size = New-Object Drawing.Size(1,1)
        $fallbackOwner.Opacity = 0
        $fallbackOwner.StartPosition = 'CenterScreen'
        $fallbackOwner.Show()
        $fallbackOwner.Activate()
        $fallbackOwner.BringToFront()
        [System.Windows.Forms.Application]::DoEvents()
        $owner = $fallbackOwner
    }
    $frontTimer = New-Object System.Windows.Forms.Timer
    $frontTimer.Interval = 100
    $frontTimer.Add_Tick({
        $popup = [ReaderPickerWindow]::GetLastActivePopup($owner.Handle)
        if ($popup -ne $owner.Handle -and [ReaderPickerWindow]::IsWindowVisible($popup)) {
            if ($fallbackOwner) { [void][ReaderPickerWindow]::SetWindowPos($popup,[IntPtr]::new(-1),0,0,0,0,0x43) }
            [void][ReaderPickerWindow]::SetForegroundWindow($popup)
            $frontTimer.Stop()
        }
    })
    $frontTimer.Start()
    $result = if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { @{path=$dialog.FileName} } else { @{cancelled=$true} }
    [Console]::WriteLine(($result | ConvertTo-Json -Compress))
} finally { if ($frontTimer) { $frontTimer.Stop(); $frontTimer.Dispose() }; $dialog.Dispose(); if ($fallbackOwner) { $fallbackOwner.Dispose() } }
