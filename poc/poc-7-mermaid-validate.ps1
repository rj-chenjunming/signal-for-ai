<#
================================================================================
 POC-7 (v2 修正版): 校验 docs/02-ARCHITECTURE.md 的 Mermaid 语法
 修正 v1 的两个自身缺陷:
   1. System.Collections.HashSet 在 PS 5.1 不存在 -> 改用普通 Hashtable
   2. graph 内联节点声明 (T01["x"] --> T02["y"]) 被误判为未声明 -> 改为逐行解析
 运行: powershell -ExecutionPolicy Bypass -File poc-7-mermaid-validate.ps1
================================================================================
#>
$ErrorActionPreference = 'Continue'
$doc = "D:\projects\ai-task-indicator\docs\02-ARCHITECTURE.md"
$lines = [System.IO.File]::ReadAllLines($doc, [System.Text.Encoding]::UTF8)

$blocks = @(); $inBlock = $false; $buf = $null; $startLine = 0
for ($i = 0; $i -lt $lines.Length; $i++) {
  $l = $lines[$i]
  if (-not $inBlock -and $l.Trim() -eq '```mermaid') { $inBlock=$true; $startLine=$i+1; $buf=New-Object System.Collections.ArrayList; continue }
  if ($inBlock -and $l.Trim() -eq '```') { $inBlock=$false; $blocks += [pscustomobject]@{ StartLine=$startLine; Lines=@($buf.ToArray()) }; continue }
  if ($inBlock) { [void]$buf.Add($l) }
}

Write-Host ("`n########## 抽取 ##########") -ForegroundColor Cyan
Write-Host ("文档行数 = " + $lines.Length + " ; mermaid 块 = " + $blocks.Count)
$fc = 0; foreach ($l in $lines) { if ($l.Trim().StartsWith('```')) { $fc++ } }
Write-Host ("``` 围栏数 = " + $fc + " -> " + $(if ($fc % 2 -eq 0) { "[OK] 配对" } else { "[FAIL] 未闭合" }))
if ($inBlock) { Write-Host "  [FAIL] 文件末尾仍在块内" -ForegroundColor Red }

$fail = 0
for ($b = 0; $b -lt $blocks.Count; $b++) {
  $blk = $blocks[$b]
  $txt = ($blk.Lines -join "`n")
  $kind = (($blk.Lines | Where-Object { $_.Trim() -ne '' } | Select-Object -First 1)).Trim()
  Write-Host ("`n--- 块#" + ($b+1) + " 行 " + $blk.StartLine + "~" + ($blk.StartLine + $blk.Lines.Length - 1) + " 类型=" + $kind + " ---")
  $ok = $true

  if ($kind -notmatch '^(classDiagram|sequenceDiagram|graph (TD|LR|TB|RL|BT))') {
    Write-Host "  [FAIL] 非法图类型: '$kind'" -ForegroundColor Red; $ok=$false
  }

  $o = ([regex]::Matches($txt,'\{')).Count; $c = ([regex]::Matches($txt,'\}')).Count
  if ($o -ne $c) { Write-Host ("  [FAIL] 花括号不配对 {=" + $o + " }=" + $c) -ForegroundColor Red; $ok=$false }

  if ($kind -eq 'classDiagram') {
    $def = @{}
    foreach ($m in [regex]::Matches($txt,'(?m)^\s*class\s+([A-Za-z_]\w*)')) { $def[$m.Groups[1].Value]=$true }
    $relBad = @(); $relGood = 0
    foreach ($m in [regex]::Matches($txt,'(?m)^\s*([A-Za-z_]\w*)\s*(?:-->|<--|\.\.>|<\.\.|\*--|\}--|--\|>|<\))\s*([A-Za-z_]\w*)')) {
      $lft = $m.Groups[1].Value
      if ($def.ContainsKey($lft)) { $relGood++ } else { $relBad += $lft }
    }
    Write-Host ("  class 定义 = " + $def.Count + " ; 关系 = " + ($relGood + $relBad.Count) + " ; 花括号 { = " + $o + " , } = " + $c)
    if ($relBad.Count -gt 0) {
      Write-Host ("  [FAIL] 关系左侧未定义: " + (($relBad|Select-Object -Unique) -join ', ')) -ForegroundColor Red; $ok=$false
    } else { Write-Host ("  [OK] " + $relGood + " 条关系左侧全部已定义") }
    $mem = ([regex]::Matches($txt,'(?m)^\s+[+\-#~]')).Count
    Write-Host ("  成员行 = " + $mem)
    $badMem = @()
    foreach ($l in $blk.Lines) { if ($l -match '^\s+[+\-#~]' -and $l -match '[，；：（）]') { $badMem += $l.Trim() } }
    if ($badMem.Count -gt 0) { Write-Host ("  [FAIL] 成员行含中文标点: " + ($badMem -join ' | ')) -ForegroundColor Red; $ok=$false }
    else { Write-Host "  [OK] 成员行无中文标点" }
  }

  if ($kind -eq 'sequenceDiagram') {
    $dec = @{}
    foreach ($m in [regex]::Matches($txt,'(?m)^\s*(?:participant|actor)\s+([A-Za-z_]\w*)\s+as\s+')) { $dec[$m.Groups[1].Value]=$true }
    $used = @{}
    $skipKw = '^(Note|loop|alt|opt|par|rect|critical|activate|deactivate|end|else|and|autonumber|break)\b'
    foreach ($l in $blk.Lines) {
      $t = $l.Trim()
      if ($t -eq '' -or $t.StartsWith('%%')) { continue }
      if ($t -match '^(participant|actor)\s') { continue }
      if ($t -match $skipKw) { continue }
      foreach ($m in [regex]::Matches($t,'([A-Za-z_]\w*)\s*(?:--?\)|-?>>?|--\)|-->)\s*([A-Za-z_]\w*)\s*:')) {
        $used[$m.Groups[1].Value]=$true; $used[$m.Groups[2].Value]=$true
      }
      foreach ($m in [regex]::Matches($t,'Note\s+over\s+([^:]+):')) {
        foreach ($n in ($m.Groups[1].Value -split ',')) { $nn=$n.Trim(); if ($nn -match '^[A-Za-z_]\w*$') { $used[$nn]=$true } }
      }
    }
    $undecl = @($used.Keys | Where-Object { -not $dec.ContainsKey($_) })
    Write-Host ("  participant 声明 = " + $dec.Count + " ; 实际使用 = " + $used.Count)
    if ($undecl.Count -gt 0) { Write-Host ("  [FAIL] 未声明的 participant: " + ($undecl -join ', ')) -ForegroundColor Red; $ok=$false }
    else { Write-Host "  [OK] 所有使用方均已声明" }
    $bo = ([regex]::Matches($txt,'(?m)^\s*(loop|alt|opt|par|critical|rect)\b')).Count
    $en = ([regex]::Matches($txt,'(?m)^\s*end\s*$')).Count
    Write-Host ("  block 开启 = " + $bo + " ; end = " + $en)
    if ($bo -ne $en) { Write-Host "  [FAIL] block/end 不配对" -ForegroundColor Red; $ok=$false } else { Write-Host "  [OK] block/end 配对" }
    $badP=@()
    foreach ($l in $blk.Lines) { if ($l -match '^\s*participant\s' -and $l -match '\(') { $badP += $l.Trim() } }
    if ($badP.Count -gt 0) { Write-Host ("  [FAIL] participant 标签含裸括号: " + ($badP -join ' | ')) -ForegroundColor Red; $ok=$false }
    else { Write-Host "  [OK] participant 标签无裸括号" }
  }

  if ($kind -match '^graph ') {
    $nodes = @{}; $edgeBad = @(); $edgeGood = 0
    foreach ($l in $blk.Lines) {
      $t = $l.Trim()
      if ($t -eq '' -or $t -match '^(graph|flowchart)\b') { continue }
      foreach ($m in [regex]::Matches($t,'([A-Za-z_]\w*)\s*\["')) { $nodes[$m.Groups[1].Value]=$true }
      foreach ($m in [regex]::Matches($t,'([A-Za-z_]\w*)\s*\[\(')) { $nodes[$m.Groups[1].Value]=$true }
      $ms = [regex]::Matches($t,'([A-Za-z_]\w*)\s*(?:\["[^\]]*"\]\s*)?-->\s*([A-Za-z_]\w*)')
      foreach ($m in $ms) { $nodes[$m.Groups[2].Value]=$true; $edgeGood++ }
      foreach ($m in $ms) {
        $lft=$m.Groups[1].Value
        if ($t -notmatch ([regex]::Escape($lft) + '\s*\["')) {
          if (-not $nodes.ContainsKey($lft)) { $edgeBad += $lft }
        }
      }
    }
    Write-Host ("  节点数 = " + $nodes.Count + " ; 边数 = " + $edgeGood)
    if ($edgeBad.Count -gt 0) { Write-Host ("  [FAIL] 边起点未声明: " + (($edgeBad|Select-Object -Unique) -join ', ')) -ForegroundColor Red; $ok=$false }
    else { Write-Host ("  [OK] " + $edgeGood + " 条边起点均已声明") }
    $q1=([regex]::Matches($txt,'\[')).Count; $q2=([regex]::Matches($txt,'\]')).Count
    Write-Host ("  方括号 [ = " + $q1 + " , ] = " + $q2)
    if ($q1 -ne $q2) { Write-Host "  [FAIL] 方括号不配对" -ForegroundColor Red; $ok=$false } else { Write-Host "  [OK] 方括号配对" }
  }

  if ($ok) { Write-Host ("  => 块#" + ($b+1) + " 通过") -ForegroundColor Green }
  else { Write-Host ("  => 块#" + ($b+1) + " 有问题") -ForegroundColor Red; $fail++ }
}

Write-Host ("`n########## 汇总 ##########") -ForegroundColor Cyan
Write-Host ("mermaid 块 = " + $blocks.Count + " ; 问题块 = " + $fail)
if ($fail -eq 0) { Write-Host "全部通过" -ForegroundColor Green } else { Write-Host "需修复" -ForegroundColor Red }