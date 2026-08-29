[CmdletBinding()]
param(
    [string]$AndroidSdk = $(if ($env:ANDROID_SDK_ROOT) {
        $env:ANDROID_SDK_ROOT
    } else {
        'C:\Users\Administrator\Documents\Codex\toolchains\android-sdk'
    }),
    [string]$JavaHome = $(if ($env:JAVA_HOME) {
        $env:JAVA_HOME
    } else {
        'C:\Program Files\Microsoft\jdk-17.0.20.8-hotspot'
    })
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$appRoot = Join-Path $projectRoot 'app'
$buildRoot = [System.IO.Path]::GetFullPath((Join-Path $appRoot 'build\manual'))
$outputRoot = [System.IO.Path]::GetFullPath((Join-Path $appRoot 'build\outputs\apk\debug'))
$projectPrefix = $projectRoot.TrimEnd('\') + '\'
if (-not $buildRoot.StartsWith($projectPrefix, [System.StringComparison]::OrdinalIgnoreCase) -or
    -not $outputRoot.StartsWith($projectPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'Android build paths escaped the project root.'
}

$buildTools = Join-Path $AndroidSdk 'build-tools\36.0.0'
$platformJar = Join-Path $AndroidSdk 'platforms\android-36\android.jar'
$aapt2 = Join-Path $buildTools 'aapt2.exe'
$zipalign = Join-Path $buildTools 'zipalign.exe'
$d8Jar = Join-Path $buildTools 'lib\d8.jar'
$apksignerJar = Join-Path $buildTools 'lib\apksigner.jar'
$java = Join-Path $JavaHome 'bin\java.exe'
$javac = Join-Path $JavaHome 'bin\javac.exe'
$jar = Join-Path $JavaHome 'bin\jar.exe'
$keytool = Join-Path $JavaHome 'bin\keytool.exe'
foreach ($required in @($platformJar, $aapt2, $d8Jar, $zipalign, $apksignerJar, $java, $javac, $jar, $keytool)) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
        throw "Required Android build tool is missing: $required"
    }
}

if (Test-Path -LiteralPath $buildRoot) {
    Remove-Item -LiteralPath $buildRoot -Recurse -Force
}
$compiledRoot = Join-Path $buildRoot 'compiled'
$generatedRoot = Join-Path $buildRoot 'generated'
$classesRoot = Join-Path $buildRoot 'classes'
$dexRoot = Join-Path $buildRoot 'dex'
New-Item -ItemType Directory -Path $compiledRoot, $generatedRoot, $classesRoot, $dexRoot, $outputRoot -Force | Out-Null

$androidJar = Join-Path $buildRoot 'android.jar'
Copy-Item -LiteralPath $platformJar -Destination $androidJar

# AGP supplies the manifest package from the namespace. Standalone aapt2 needs
# the same value in a derived manifest, so never alter the Gradle source manifest.
$sourceManifest = Join-Path $appRoot 'src\main\AndroidManifest.xml'
[xml]$manifestXml = Get-Content -LiteralPath $sourceManifest -Raw
$manifestXml.manifest.SetAttribute('package', 'cn.xiaoli.control')
$derivedManifest = Join-Path $buildRoot 'AndroidManifest.xml'
$manifestXml.Save($derivedManifest)

$resourcesArchive = Join-Path $compiledRoot 'resources.zip'
& $aapt2 compile --dir (Join-Path $appRoot 'src\main\res') -o $resourcesArchive
if ($LASTEXITCODE -ne 0) { throw 'aapt2 resource compilation failed.' }

$resourceApk = Join-Path $buildRoot 'resources.apk'
& $aapt2 link -o $resourceApk -I $androidJar --manifest $derivedManifest `
    --java $generatedRoot --min-sdk-version 26 --target-sdk-version 36 `
    --version-code 1 --version-name 1.0 $resourcesArchive
if ($LASTEXITCODE -ne 0) { throw 'aapt2 resource linking failed.' }

$javaSources = @(
    Get-ChildItem -LiteralPath (Join-Path $appRoot 'src\main\java') -Recurse -Filter '*.java' |
        ForEach-Object FullName
    Get-ChildItem -LiteralPath $generatedRoot -Recurse -Filter '*.java' |
        ForEach-Object FullName
)
& $javac -encoding UTF-8 -source 17 -target 17 -classpath $androidJar -d $classesRoot $javaSources
if ($LASTEXITCODE -ne 0) { throw 'Java compilation failed.' }

$classesJar = Join-Path $buildRoot 'classes.jar'
& $jar --create --file $classesJar -C $classesRoot .
if ($LASTEXITCODE -ne 0) { throw 'Java archive creation failed.' }

& $java -Xmx1024M -Xss1m -cp $d8Jar com.android.tools.r8.D8 `
    --lib $androidJar --min-api 26 --output $dexRoot $classesJar
if ($LASTEXITCODE -ne 0) { throw 'D8 bytecode conversion failed.' }

& $jar --update --file $resourceApk -C $dexRoot classes.dex
if ($LASTEXITCODE -ne 0) { throw 'classes.dex packaging failed.' }

$alignedApk = Join-Path $buildRoot 'aligned.apk'
& $zipalign -f -p 4 $resourceApk $alignedApk
if ($LASTEXITCODE -ne 0) { throw 'APK alignment failed.' }

$signingRoot = Join-Path $projectRoot '.signing'
$debugKeyStore = Join-Path $signingRoot 'debug.keystore'
New-Item -ItemType Directory -Path $signingRoot -Force | Out-Null
if (-not (Test-Path -LiteralPath $debugKeyStore -PathType Leaf)) {
    & $keytool -genkeypair -keystore $debugKeyStore -storepass android `
        -alias androiddebugkey -keypass android -dname 'CN=Android Debug,O=Android,C=US' `
        -keyalg RSA -keysize 2048 -validity 10000
    if ($LASTEXITCODE -ne 0) { throw 'Debug signing key creation failed.' }
}

$outputApk = Join-Path $outputRoot 'xiaoli-control-debug.apk'
& $java -Xmx1024M -Xss1m -jar $apksignerJar sign --ks $debugKeyStore `
    --ks-pass pass:android --key-pass pass:android --out $outputApk $alignedApk
if ($LASTEXITCODE -ne 0) { throw 'APK signing failed.' }

& $java -Xmx1024M -Xss1m -jar $apksignerJar verify --verbose --print-certs $outputApk
if ($LASTEXITCODE -ne 0) { throw 'APK signature verification failed.' }
& $zipalign -c -v 4 $outputApk
if ($LASTEXITCODE -ne 0) { throw 'APK alignment verification failed.' }

$hash = Get-FileHash -LiteralPath $outputApk -Algorithm SHA256
Write-Output "APK=$outputApk"
Write-Output "SHA256=$($hash.Hash)"
