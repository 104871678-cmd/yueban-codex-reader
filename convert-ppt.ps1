param([Parameter(Mandatory=$true)][string]$InputFile, [Parameter(Mandatory=$true)][string]$OutputFile)
$ErrorActionPreference = 'Stop'
$app = $null
$deck = $null
try {
    if ([type]::GetTypeFromProgID('PowerPoint.Application')) {
        $app = New-Object -ComObject PowerPoint.Application
        $app.AutomationSecurity = 3
        $deck = $app.Presentations.Open($InputFile, -1, 0, 0)
        $deck.SaveAs($OutputFile, 32)
    } else {
        $candidates = @(
            "$env:ProgramFiles\LibreOffice\program\soffice.exe",
            "${env:ProgramFiles(x86)}\LibreOffice\program\soffice.exe"
        )
        $officeCmd = Get-Command soffice.exe -ErrorAction SilentlyContinue
        if ($officeCmd) { $candidates += $officeCmd.Source }
        $soffice = $candidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
        if (-not $soffice) { throw 'No PowerPoint or LibreOffice installed.' }
        $folder = Split-Path -Parent $OutputFile
        $profile = Join-Path $folder ([guid]::NewGuid().ToString() + '-lo-profile')
        $profileUri = ([System.Uri]$profile).AbsoluteUri
        & $soffice "-env:UserInstallation=$profileUri" --headless --convert-to pdf --outdir $folder $InputFile | Out-Null
        $generated = Join-Path $folder (([System.IO.Path]::GetFileNameWithoutExtension($InputFile)) + '.pdf')
        if (-not (Test-Path -LiteralPath $generated)) { throw 'LibreOffice conversion failed.' }
        Move-Item -LiteralPath $generated -Destination $OutputFile
        # This profile was created only for this conversion; leave it for explicit user cleanup.
    }
    if (-not (Test-Path -LiteralPath $OutputFile)) { throw 'The PDF was not created.' }
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
} finally {
    if ($deck) { $deck.Close(); [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($deck) }
    if ($app) { $app.Quit(); [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($app) }
}
