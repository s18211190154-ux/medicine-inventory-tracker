Add-Type -AssemblyName System.Drawing

function New-RoundedRect([System.Drawing.Drawing2D.GraphicsPath]$gp,
  [float]$x, [float]$y, [float]$w, [float]$h, [float]$r) {
  $gp.AddArc($x, $y, 2*$r, 2*$r, 180, 90)
  $gp.AddArc($x+$w-2*$r, $y, 2*$r, 2*$r, 270, 90)
  $gp.AddArc($x+$w-2*$r, $y+$h-2*$r, 2*$r, 2*$r, 0, 90)
  $gp.AddArc($x, $y+$h-2*$r, 2*$r, 2*$r, 90, 90)
  $gp.CloseFigure()
}

# 128px master
$size = 128
$bmp = New-Object System.Drawing.Bitmap($size, $size)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = 'AntiAlias'

# teal gradient rounded background
$bgPath = New-Object System.Drawing.Drawing2D.GraphicsPath
New-RoundedRect $bgPath 2 2 124 124 28
$bgBrush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
  (New-Object System.Drawing.Rectangle(0,0,$size,$size)),
  [System.Drawing.Color]::FromArgb(255,20,184,166),
  [System.Drawing.Color]::FromArgb(255,13,104,104),
  45)
$g.FillPath($bgBrush, $bgPath)

# white capsule rotated -45deg
$g.TranslateTransform(64, 64)
$g.RotateTransform(-45)
$capPath = New-Object System.Drawing.Drawing2D.GraphicsPath
New-RoundedRect $capPath -46 -17 92 34 17
$white = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)
$g.FillPath($white, $capPath)

# red half of the capsule (right half)
New-Item -ItemType Directory -Force -Path icons | Out-Null

$g.SetClip([System.Drawing.RectangleF]::new(0, -40, 60, 80))
$red = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255,225,60,60))
$g.FillPath($red, $capPath)

$g.ResetClip()
$g.ResetTransform()

# small cross pill sparkle bottom-right (subtle)
$pen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(120,255,255,255), 3)
$g.DrawLine($pen, 100, 18, 100, 30)
$g.DrawLine($pen, 94, 24, 106, 24)
$g.Dispose()

# resize to standard sizes with high quality bicubic
foreach ($s in 16, 32, 48, 128) {
  $out = New-Object System.Drawing.Bitmap($s, $s)
  $og = [System.Drawing.Graphics]::FromImage($out)
  $og.InterpolationMode = 'HighQualityBicubic'
  $og.SmoothingMode = 'AntiAlias'
  $og.PixelOffsetMode = 'HighQuality'
  $og.DrawImage($bmp, 0, 0, $s, $s)
  $og.Dispose()
  $out.Save("icons\icon$s.png", [System.Drawing.Imaging.ImageFormat]::Png)
  $out.Dispose()
}
$bmp.Dispose()
Write-Host "Icons generated:"
