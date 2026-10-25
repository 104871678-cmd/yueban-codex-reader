param([Parameter(Mandatory=$true)][string]$InputFile, [Parameter(Mandatory=$true)][string]$OutputDirectory)
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
$application = $null; $deck = $null; $owned = $false; $security = $null
function Send-Result($value) { [Console]::WriteLine(($value | ConvertTo-Json -Compress)); [Console]::Out.Flush() }
function Export-Page([int]$page) {
    if ($page -lt 1 -or $page -gt $deck.Slides.Count) { throw 'Page is outside this presentation.' }
    $target = Join-Path $OutputDirectory ('page-' + $page + '.png')
    if (-not (Test-Path -LiteralPath $target)) {
        $slide = $deck.Slides.Item($page)
        try { $slide.Export($target, 'PNG', $pixelWidth, $pixelHeight) }
        finally { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($slide) }
    }
    if (-not (Test-Path -LiteralPath $target)) { throw 'The slide image was not created.' }
}
try {
    foreach ($progId in @('KWPP.Application', 'PowerPoint.Application')) {
        if (-not [type]::GetTypeFromProgID($progId)) { continue }
        try {
            try { $application = [Runtime.InteropServices.Marshal]::GetActiveObject($progId); $owned = $false }
            catch { $application = New-Object -ComObject $progId; $owned = $true }
            $engine = if ($progId -eq 'KWPP.Application') { 'WPS' } else { 'PowerPoint' }
            break
        } catch { $application = $null }
    }
    if (-not $application) { throw 'Install WPS or Microsoft PowerPoint, or save the presentation as PDF.' }
    $security = $application.AutomationSecurity
    $application.AutomationSecurity = 3
    try { $deck = $application.Presentations.Open($InputFile, -1, 0, 0) }
    finally { if ($null -ne $security) { $application.AutomationSecurity = $security; $security = $null } }
    $width = [double]$deck.PageSetup.SlideWidth; $height = [double]$deck.PageSetup.SlideHeight
    if ($width -le 0 -or $height -le 0) { throw 'Invalid slide dimensions.' }
    $pixelWidth = 1600; $pixelHeight = [int][math]::Round($pixelWidth * $height / $width)
    Export-Page 1
    Send-Result @{ type='ready'; engine=$engine; count=$deck.Slides.Count; width=$width; height=$height; pixelWidth=$pixelWidth; pixelHeight=$pixelHeight }
    while ($null -ne ($line = [Console]::ReadLine())) {
        if (-not $line.Trim()) { continue }
        $command = $null
        try {
            $command = $line | ConvertFrom-Json
            if ($command.method -eq 'close') { break }
            Export-Page ([int]$command.page)
            Send-Result @{ id=$command.id; page=[int]$command.page }
        } catch { Send-Result @{ id=$command.id; error=$_.Exception.Message } }
    }
} catch { Send-Result @{ type='fatal'; error=$_.Exception.Message }; exit 1 }
finally {
    if ($deck) { try { $deck.Close() } catch {}; [void][Runtime.InteropServices.Marshal]::ReleaseComObject($deck) }
    if ($application) {
        if ($null -ne $security) { try { $application.AutomationSecurity = $security } catch {} }
        # Never quit an application that still has another presentation open.
        if ($owned) { try { if ($application.Presentations.Count -eq 0) { $application.Quit() } } catch {} }
        [void][Runtime.InteropServices.Marshal]::ReleaseComObject($application)
    }
}
