param([Parameter(Mandatory=$true)][string]$Jdk,[Parameter(Mandatory=$true)][string]$BuildTools,[Parameter(Mandatory=$true)][string]$AndroidJar)
$ErrorActionPreference='Stop'
$projectDir=$PSScriptRoot
$buildDir=Join-Path $projectDir 'local-build'
$srcDir=Join-Path $projectDir 'app/src/main'
New-Item -ItemType Directory -Force "$buildDir/classes","$buildDir/dex" | Out-Null
function Invoke-Checked { param([string]$Exe,[string[]]$Arguments) & $Exe @Arguments; if($LASTEXITCODE -ne 0){throw "Build command failed: $Exe"} }
Invoke-Checked "$Jdk/bin/javac.exe" @('-encoding','UTF-8','--release','8','-classpath',$AndroidJar,'-d',"$buildDir/classes","$srcDir/java/com/runlab/app/MainActivity.java","$srcDir/java/com/runlab/app/RunRecorderService.java","$srcDir/java/com/runlab/app/KeepUploader.java","$srcDir/java/com/runlab/app/KeepAuth.java","$srcDir/java/com/runlab/app/KeepSessionStore.java","$srcDir/java/com/runlab/app/RunPaceSamples.java","$srcDir/java/com/runlab/app/KeepHistory.java")
Invoke-Checked "$Jdk/bin/jar.exe" @('cf',"$buildDir/classes.jar",'-C',"$buildDir/classes",'.')
Invoke-Checked "$Jdk/bin/java.exe" @('-cp',"$BuildTools/lib/d8.jar",'com.android.tools.r8.D8','--min-api','26','--lib',$AndroidJar,'--output',"$buildDir/dex","$buildDir/classes.jar")
Invoke-Checked "$BuildTools/aapt.exe" @('package','-f','-M',"$srcDir/AndroidManifest.xml",'-I',$AndroidJar,'-A',"$srcDir/assets",'-S',"$srcDir/res",'-F',"$buildDir/unsigned.apk")
Invoke-Checked "$Jdk/bin/jar.exe" @('uf',"$buildDir/unsigned.apk",'-C',"$buildDir/dex",'classes.dex')
Invoke-Checked "$BuildTools/zipalign.exe" @('-f','4',"$buildDir/unsigned.apk","$buildDir/aligned.apk")
if(!(Test-Path "$buildDir/debug.jks")){Invoke-Checked "$Jdk/bin/keytool.exe" @('-genkeypair','-keystore',"$buildDir/debug.jks",'-storepass','android','-keypass','android','-alias','androiddebugkey','-dname','CN=RunLab Debug,O=RunLab,C=CN','-keyalg','RSA','-keysize','2048','-validity','10000')}
Invoke-Checked "$Jdk/bin/java.exe" @('-jar',"$BuildTools/lib/apksigner.jar",'sign','--ks',"$buildDir/debug.jks",'--ks-pass','pass:android','--out',"$buildDir/RunLab-debug.apk","$buildDir/aligned.apk")
Invoke-Checked "$Jdk/bin/java.exe" @('-jar',"$BuildTools/lib/apksigner.jar",'verify','--verbose',"$buildDir/RunLab-debug.apk")
Write-Output "Built $buildDir/RunLab-debug.apk"
