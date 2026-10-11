# Reads table Receipts from an Access file (.accdb/.mdb) and writes it as JSON (UTF-8).
# Used by the app's import; can also be run by hand:
#   powershell -ExecutionPolicy Bypass -File read-accdb.ps1 "C:\path\Centro_Tower_Pro.accdb" out.json
param([Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)][string]$Out)
$ErrorActionPreference = 'Stop'

$cn = New-Object -ComObject ADODB.Connection
$opened = $false
foreach ($prov in 'Microsoft.ACE.OLEDB.16.0', 'Microsoft.ACE.OLEDB.12.0') {
    try { $cn.Open("Provider=$prov;Data Source=$Path;Mode=Read;"); $opened = $true; break } catch { }
}
if (-not $opened) {
    throw "Cannot open the Access file. Install 'Microsoft Access Database Engine' (64-bit), or export table Receipts to CSV and import the CSV instead."
}

$rs = $cn.Execute('SELECT * FROM Receipts')
$rows = New-Object System.Collections.ArrayList
while (-not $rs.EOF) {
    $o = [ordered]@{}
    foreach ($f in $rs.Fields) {
        $v = $f.Value
        if ($v -is [DBNull] -or $null -eq $v) { $o[$f.Name] = $null }
        elseif ($v -is [DateTime]) { $o[$f.Name] = $v.ToString('yyyy-MM-dd HH:mm:ss', [Globalization.CultureInfo]::InvariantCulture) }
        elseif ($v -is [bool]) { $o[$f.Name] = $v }
        elseif ($v -is [decimal] -or $v -is [double] -or $v -is [single]) { $o[$f.Name] = [double]$v }
        else { $o[$f.Name] = $v }
    }
    [void]$rows.Add([pscustomobject]$o)
    $rs.MoveNext()
}
$rs.Close(); $cn.Close()

$json = ConvertTo-Json -InputObject @($rows.ToArray()) -Depth 3
if (-not $json) { $json = '[]' }
# write to a temp name, then rename: the file only appears when it is complete.
# (The Access engine sometimes crashes PowerShell while it shuts down; the caller trusts this file, not the exit code.)
[IO.File]::WriteAllText("$Out.part", $json, (New-Object Text.UTF8Encoding $false))
Move-Item -LiteralPath "$Out.part" -Destination $Out -Force
