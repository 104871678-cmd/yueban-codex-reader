$ErrorActionPreference='Stop'
[Console]::InputEncoding=[Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
function Emit($value){[Console]::WriteLine(($value | ConvertTo-Json -Compress -Depth 5))}
try{
 Add-Type -AssemblyName System.Runtime.WindowsRuntime
 $null=[Windows.Media.Ocr.OcrEngine,Windows.Foundation,ContentType=WindowsRuntime]
 $null=[Windows.Storage.StorageFile,Windows.Storage,ContentType=WindowsRuntime]
 $null=[Windows.Storage.Streams.IRandomAccessStream,Windows.Storage.Streams,ContentType=WindowsRuntime]
 $null=[Windows.Graphics.Imaging.BitmapDecoder,Windows.Foundation,ContentType=WindowsRuntime]
 $null=[Windows.Graphics.Imaging.SoftwareBitmap,Windows.Foundation,ContentType=WindowsRuntime]
 $null=[Windows.Media.Ocr.OcrResult,Windows.Foundation,ContentType=WindowsRuntime]
 $ocrEngine=[Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
 if(-not $ocrEngine){throw 'No local OCR language is installed.'}
 $ocrAwaitMethod=[System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {$_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'} | Select-Object -First 1
 function Await-Ocr($operation,[Type]$resultType){$task=$ocrAwaitMethod.MakeGenericMethod($resultType).Invoke($null,@($operation));$task.Wait();return $task.Result}
 Emit @{type='ready';available=$true;language=$ocrEngine.RecognizerLanguage.LanguageTag}
 while($null -ne ($line=[Console]::ReadLine())){
  $request=$line | ConvertFrom-Json
  if($request.method -eq 'close'){break}
  $stream=$null;$bitmap=$null
  try{
   $file=Await-Ocr ([Windows.Storage.StorageFile]::GetFileFromPathAsync([string]$request.path)) ([Windows.Storage.StorageFile])
   $stream=Await-Ocr ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
   $decoder=Await-Ocr ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
   $bitmap=Await-Ocr ($decoder.GetSoftwareBitmapAsync([Windows.Graphics.Imaging.BitmapPixelFormat]::Bgra8,[Windows.Graphics.Imaging.BitmapAlphaMode]::Premultiplied)) ([Windows.Graphics.Imaging.SoftwareBitmap])
   $result=Await-Ocr ($ocrEngine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
   $text=($result.Lines | ForEach-Object {$_.Text}) -join "`n"
   Emit @{id=$request.id;text=$text}
  }catch{Emit @{id=$request.id;error=$_.Exception.Message}}
  finally{if($bitmap){$bitmap.Dispose()};if($stream){$stream.Dispose()}}
 }
}catch{Emit @{type='ready';available=$false;error=$_.Exception.Message}}
