Add-Type -AssemblyName PresentationCore
Add-Type -AssemblyName WindowsBase
Add-Type -AssemblyName System.Xaml
$videoPath = 'C:\Users\hieut\Downloads\Recording 2026-06-15 004319.mp4'
$outPath = 'D:\code\music-app-react-lite\tmp\recording-frame.png'
$player = New-Object System.Windows.Media.MediaPlayer
$player.ScrubbingEnabled = $true
$opened = $false
$player.add_MediaOpened({ $script:opened = $true })
$player.Open([Uri]$videoPath)
$deadline = [DateTime]::Now.AddSeconds(10)
while (-not $opened -and [DateTime]::Now -lt $deadline) {
  [System.Windows.Threading.Dispatcher]::CurrentDispatcher.Invoke([Action]{} , [System.Windows.Threading.DispatcherPriority]::Background)
  Start-Sleep -Milliseconds 100
}
if (-not $opened) { throw 'Media did not open' }
$width = [int]$player.NaturalVideoWidth
$height = [int]$player.NaturalVideoHeight
if ($width -le 0 -or $height -le 0) { throw "Invalid video size $width x $height" }
$player.Position = [TimeSpan]::FromSeconds(1)
$player.Play()
Start-Sleep -Milliseconds 600
$player.Pause()
$visual = New-Object System.Windows.Media.DrawingVisual
$context = $visual.RenderOpen()
$context.DrawVideo($player, (New-Object System.Windows.Rect 0, 0, $width, $height))
$context.Close()
$bitmap = New-Object System.Windows.Media.Imaging.RenderTargetBitmap $width, $height, 96, 96, ([System.Windows.Media.PixelFormats]::Pbgra32)
$bitmap.Render($visual)
$encoder = New-Object System.Windows.Media.Imaging.PngBitmapEncoder
$encoder.Frames.Add([System.Windows.Media.Imaging.BitmapFrame]::Create($bitmap))
$stream = [System.IO.File]::Open($outPath, [System.IO.FileMode]::Create)
$encoder.Save($stream)
$stream.Close()
$player.Close()
Write-Output "$outPath $width x $height"
