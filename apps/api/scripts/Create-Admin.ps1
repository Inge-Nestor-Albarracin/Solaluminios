$ErrorActionPreference = 'Stop'
$previousDirectory = Get-Location
$pointer = [IntPtr]::Zero
try {
    Set-Location (Join-Path $PSScriptRoot '..')
    $env:BOOTSTRAP_ADMIN_NAME = Read-Host 'Nombre del administrador'
    $env:BOOTSTRAP_ADMIN_USERNAME = Read-Host 'Usuario para ingresar (p. ej. pedro.alvarez)'
    $env:BOOTSTRAP_ADMIN_EMAIL = Read-Host 'Correo del administrador (opcional, Enter para omitir)'
    $securePassword = Read-Host 'Contrasena (12 a 128 caracteres)' -AsSecureString
    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword)
    $env:BOOTSTRAP_ADMIN_PASSWORD = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
    & pnpm exec tsx .\src\scripts\create-admin.ts
    if ($LASTEXITCODE -ne 0) { throw 'No se completo la creacion del administrador' }
}
finally {
    if ($pointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
    Remove-Item Env:BOOTSTRAP_ADMIN_NAME -ErrorAction SilentlyContinue
    Remove-Item Env:BOOTSTRAP_ADMIN_EMAIL -ErrorAction SilentlyContinue
    Remove-Item Env:BOOTSTRAP_ADMIN_USERNAME -ErrorAction SilentlyContinue
    Remove-Item Env:BOOTSTRAP_ADMIN_PASSWORD -ErrorAction SilentlyContinue
    Set-Location $previousDirectory
}
