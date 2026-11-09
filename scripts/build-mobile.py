#!/usr/bin/env python3
"""Build the personal Android APK with official SDK tools; no Gradle dependencies."""
import hashlib, json, os, pathlib, subprocess, shutil, zipfile, xml.etree.ElementTree as ET
root=pathlib.Path(__file__).resolve().parents[1]
tools=pathlib.Path(os.environ.get('AURORA_ANDROID_TOOLS',str(pathlib.Path.home()/'.local/share/aurora-android-tools')))
java=tools/'jdk'; bt=tools/'build-tools'; platform=tools/'platform/android.jar'
for p in [java/'bin/javac',bt/'aapt2',bt/'d8',bt/'apksigner',platform]:
    if not p.exists():raise SystemExit(f'Missing Android build prerequisite: {p}. See mobile/README.md.')
env={**os.environ,'JAVA_HOME':str(java),'PATH':str(java/'bin')+os.pathsep+os.environ['PATH']}
out=root/'artifacts/mobile-build'; out.mkdir(parents=True,exist_ok=True)
for name in ['classes','dex']:
    p=out/name
    if p.exists():shutil.rmtree(p)
    p.mkdir()
def run(*args):subprocess.run(list(map(str,args)),check=True,env=env)
run(bt/'aapt2','compile','--dir',root/'mobile/android/res','-o',out/'resources.zip')
run(bt/'aapt2','link','-o',out/'base.apk','-I',platform,'--manifest',root/'mobile/android/AndroidManifest.xml','--min-sdk-version','26','--target-sdk-version','35','-A',root/'mobile/web',out/'resources.zip')
sources=sorted((root/'mobile/android/src').rglob('*.java'))
run(java/'bin/javac','-encoding','UTF-8','-source','8','-target','8','-bootclasspath',str(bt/'core-lambda-stubs.jar')+os.pathsep+str(platform),'-d',out/'classes',*sources)
run(bt/'d8','--lib',platform,'--min-api','26','--output',out/'dex',*sorted((out/'classes').rglob('*.class')))
with zipfile.ZipFile(out/'base.apk','a',zipfile.ZIP_DEFLATED) as z:
    for p in (out/'dex').glob('*.dex'):z.write(p,p.name)
run(bt/'zipalign','-f','4',out/'base.apk',out/'aligned.apk')
# Stable local development signer: keep it outside source/exports so updates retain app data.
signer=tools/'aurora-development.p12'
if not signer.exists():
    run(java/'bin/keytool','-genkeypair','-keystore',signer,'-storepass','android','-keypass','android','-alias','aurora','-keyalg','RSA','-keysize','3072','-validity','10000','-dname','CN=Aurora Personal Development')
    signer.chmod(0o600)
version=ET.parse(root/'mobile/android/AndroidManifest.xml').getroot().attrib['{http://schemas.android.com/apk/res/android}versionName']
apk=root/('artifacts/Aurora-Mobile-'+version+'.apk')
run(bt/'apksigner','sign','--ks',signer,'--ks-pass','pass:android','--ks-key-alias','aurora','--out',apk,out/'aligned.apk')
run(bt/'apksigner','verify','--verbose',apk)
report={'apk':str(apk),'sha256':hashlib.sha256(apk.read_bytes()).hexdigest(),'bytes':apk.stat().st_size,'sources':{str(p.relative_to(root)):hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted((root/'mobile').rglob('*')) if p.is_file()}}
(root/'artifacts/mobile-build.json').write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps({k:v for k,v in report.items() if k!='sources'},indent=2))
