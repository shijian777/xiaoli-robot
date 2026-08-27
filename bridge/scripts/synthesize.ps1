[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$Text,

  [Parameter(Mandatory = $true)]
  [string]$OutputPath
)

$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($Text)) {
  throw 'Text must not be empty.'
}

if ([string]::IsNullOrWhiteSpace($OutputPath)) {
  throw 'OutputPath must not be empty.'
}

Add-Type -AssemblyName System.Speech

$synthesizer = $null
try {
  $synthesizer = [System.Speech.Synthesis.SpeechSynthesizer]::new()
  $huihui = $synthesizer.GetInstalledVoices() |
    Where-Object { $_.Enabled -and $_.VoiceInfo.Name.StartsWith('Microsoft Huihui Desktop', [System.StringComparison]::OrdinalIgnoreCase) } |
    Select-Object -First 1

  if ($null -ne $huihui) {
    $synthesizer.SelectVoice($huihui.VoiceInfo.Name)
  }

  $format = [System.Speech.AudioFormat.SpeechAudioFormatInfo]::new(
    16000,
    [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen,
    [System.Speech.AudioFormat.AudioChannel]::Mono
  )
  $synthesizer.SetOutputToWaveFile($OutputPath, $format)
  $synthesizer.Speak($Text)
} finally {
  if ($null -ne $synthesizer) {
    $synthesizer.Dispose()
  }
}
