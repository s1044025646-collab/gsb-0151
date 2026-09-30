# Removes only build/runtime artifacts inside THIS project.
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
foreach ($name in @('dist', '.gbc')) {
  $target = Join-Path $root $name
  if (Test-Path -LiteralPath $target) {
    Remove-Item -LiteralPath $target -Recurse -Force
    Write-Host "removed $target"
  }
}
