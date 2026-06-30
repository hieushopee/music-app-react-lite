Add-Type -AssemblyName PresentationCore
Add-Type -AssemblyName WindowsBase
$videoPath = 'C:\Users\hieut\Downloads\Recording 2026-06-15 004319.mp4'
$outDir = 'D:\code\music-app-react-lite\tmp\recording-frames'
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
$times = @(0, 0.5, 1, 2, 3, 4, 5)
foreach ($second in $times) {
  $player = New-Object System.Windows.Media.MediaPlayer
  $player.ScrubbingEnabled = $true
  $opened = $false
  $player.add_MediaOpened({ $script:opened = $true })
  $player.Open([Uri]$videoPath)
  $deadline = [DateTime]::Now.AddSeconds(10)
  while (-not $opened -and [DateTime]::Now -lt $deadline) {
    [System.Windows.Threading.Dispatcher]::CurrentDispatcher.Invoke([Action]{} , [System.Windows.Threading.DispatcherPriority]::Background)
    Start-Sleep -Milliseconds 80
  }
  if (-not $opened) { throw 'Media did not open' }
  $width = [int]$player.NaturalVideoWidth
  $height = [int]$player.NaturalVideoHeight
  $player.Position = [TimeSpan]::FromSeconds($second)
  $player.Play()
  Start-Sleep -Milliseconds 650
  $player.Pause()
  $visual = New-Object System.Windows.Media.DrawingVisual
  $context = $visual.RenderOpen()
  $context.DrawVideo($player, (New-Object System.Windows.Rect 0, 0, $width, $height))
  $context.Close()
  $bitmap = New-Object System.Windows.Media.Imaging.RenderTargetBitmap $width, $height, 96, 96, ([System.Windows.Media.PixelFormats]::Pbgra32)
  $bitmap.Render($visual)
  $encoder = New-Object System.Windows.Media.Imaging.PngBitmapEncoder
  $encoder.Frames.Add([System.Windows.Media.Imaging.BitmapFrame]::Create($bitmap))
  $outPath = Join-Path $outDir ("frame-{0}.png" -f ($second.ToString().Replace('.','_')))
  $stream = [System.IO.File]::Open($outPath, [System.IO.FileMode]::Create)
  $encoder.Save($stream)
  $stream.Close()
  $player.Close()
  Write-Output $outPath
}
