#!/usr/bin/env bash
# Build the StudyHub Android app → dist/StudyHub.apk
# Copies www/ into the Android project, then compiles with Gradle.
set -euo pipefail
cd "$(dirname "$0")"
export PATH="$HOME/.local/opt/node/bin:$PATH"
export ANDROID_HOME="${ANDROID_HOME:-$HOME/Android/Sdk}"
# Capacitor's JS runtime (registerPlugin etc.) must ship with the app: copy the installed version
cp node_modules/@capacitor/core/dist/capacitor.js www/vendor/capacitor.js
npx cap sync android
(cd android && ./gradlew --quiet assembleDebug)
mkdir -p dist
cp android/app/build/outputs/apk/debug/app-debug.apk dist/StudyHub.apk
echo
echo "Built dist/StudyHub.apk ($(du -h dist/StudyHub.apk | cut -f1))"
echo "Get it onto your phone:  ./run.sh phone   then open  http://<laptop-ip>:8000/StudyHub.apk  on the phone"
