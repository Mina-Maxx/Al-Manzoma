Add-Type -AssemblyName System.Drawing
$sizes = @{
    'mipmap-mdpi' = 48
    'mipmap-hdpi' = 72
    'mipmap-xhdpi' = 96
    'mipmap-xxhdpi' = 144
    'mipmap-xxxhdpi' = 192
}
$baseDir = 'C:\Users\Mina Max\Downloads\0xAnub1sX\quarryvault\android\app\src\main\res'

foreach ($key in $sizes.Keys) {
    $dir = Join-Path $baseDir $key
    if (-not (Test-Path $dir)) {
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
    }
    $size = [float]$sizes[$key]
    $bmp = New-Object System.Drawing.Bitmap([int]$size, [int]$size)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias

    # Background
    $bgBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(11, 25, 44))
    $g.FillRectangle($bgBrush, 0, 0, [int]$size, [int]$size)

    # Mountain peak 1 (navy blue)
    $pt1 = New-Object System.Drawing.PointF([float]($size * 0.2), [float]($size * 0.76))
    $pt2 = New-Object System.Drawing.PointF([float]($size * 0.45), [float]($size * 0.38))
    $pt3 = New-Object System.Drawing.PointF([float]($size * 0.7), [float]($size * 0.76))
    $p1 = [System.Drawing.PointF[]]@($pt1, $pt2, $pt3)
    $m1Brush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(30, 62, 98))
    $g.FillPolygon($m1Brush, $p1)

    # Mountain peak 2 (gold quarry stone)
    $pt4 = New-Object System.Drawing.PointF([float]($size * 0.4), [float]($size * 0.76))
    $pt5 = New-Object System.Drawing.PointF([float]($size * 0.65), [float]($size * 0.32))
    $pt6 = New-Object System.Drawing.PointF([float]($size * 0.9), [float]($size * 0.76))
    $p2 = [System.Drawing.PointF[]]@($pt4, $pt5, $pt6)
    $m2Brush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(243, 156, 18))
    $g.FillPolygon($m2Brush, $p2)

    # Base strip (terracotta)
    $baseBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(211, 84, 0))
    $g.FillRectangle($baseBrush, [float]($size * 0.15), [float]($size * 0.76), [float]($size * 0.7), [float]($size * 0.08))

    $g.Dispose()

    $launcherPath = Join-Path $dir 'ic_launcher.png'
    $launcherRoundPath = Join-Path $dir 'ic_launcher_round.png'
    $bmp.Save($launcherPath, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Save($launcherRoundPath, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
}
Write-Output "Generated density mipmap icons successfully."
