param([string]$InitialDirectory = '')
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
Add-Type -AssemblyName System.Windows.Forms
$dialog = New-Object System.Windows.Forms.OpenFileDialog
$owner = New-Object System.Windows.Forms.Form
$owner.TopMost = $true
$owner.ShowInTaskbar = $false
try {
    $dialog.Title = '打开文档 · 阅伴'
    $dialog.Filter = '课程文档 (*.pdf;*.ppt;*.pptx;*.html;*.htm)|*.pdf;*.ppt;*.pptx;*.html;*.htm'
    $dialog.CheckFileExists = $true
    $dialog.Multiselect = $false
    if ($InitialDirectory -and [IO.Directory]::Exists($InitialDirectory)) { $dialog.InitialDirectory = $InitialDirectory }
    $result = if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { @{path=$dialog.FileName} } else { @{cancelled=$true} }
    [Console]::WriteLine(($result | ConvertTo-Json -Compress))
} finally { $dialog.Dispose(); $owner.Dispose() }
