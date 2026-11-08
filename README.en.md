# SHOU U RUN

[Windows desktop app](desktop/README.md)

[中文版 README](README.md)

An Android app for experimenting with running routes and activity data. Choose points on a map, plan a route along mapped pedestrian ways near campus, adjust activity parameters, and export simulated GPX or FIT files. You can also record your own raw runs with your phone's GPS and export them as JSONL for later analysis.

**Current version: Android 1.2.1 / Windows 1.2.2.** [Download the Android APK](https://github.com/x-zyz/SHOU-U-RUN/releases/tag/v1.2.1) · [Download the Windows x64 EXE](https://github.com/x-zyz/SHOU-U-RUN/releases/tag/v1.2.2) Simulated data and real GPS recordings are labeled separately in the app and its files. Sign in to Keep with a mainland China phone number and an SMS code, or enter a token manually. On Android 1.0.4 and later, the app encrypts SMS login tokens on the device and can save manually entered tokens on request. Valid sessions are restored after restart. Signing out removes the saved credential. Windows also encrypts saved credentials and fits personal pace profiles from Android JSONL exports or outdoor runs in Keep history. The generation algorithm is still being refined.

## Features

- An offline vector map of Shanghai, with optional OpenStreetMap online maps and Esri satellite imagery.
- Near Shanghai Ocean University, selected points snap to the local pedestrian network. Route planning uses mapped sidewalks, pedestrian streets, and crossings. In other areas, the map can currently be viewed, but routes cannot be planned.
- Generate simulated activities using a target pace and random variation, then export GPX or FIT. A sample route runs from Longguang Blue Whale World (龙光蓝鲸世界) to Gate 1 of Shanghai Ocean University.
- Submit the current simulated activity to your own Keep account. This uses an unofficial interface; check the resulting record and its source in Keep.
- Record real GPS fixes with an Android foreground service, including time, location, accuracy, speed, and pause events, then export raw JSONL. Fit a personal pace profile locally from completed GPS runs or switch back to the default model. Heart rate and cadence remain configurable simulation parameters.

## Build

Android 8.0 or later is required. Open this directory in Android Studio and build the `app` module with JDK 17, Android SDK 35, and Gradle 8.9. The project uses Android Gradle Plugin 8.7.3. A Gradle wrapper and SDK are not bundled.

Alternatively, run `build-local.ps1` in PowerShell and provide paths to JDK 17, Android SDK Build Tools, and `android.jar`. The script generates a debug-signed APK in `local-build/`. It creates a debug signing key locally; never use that key for a production release.

```powershell
.\build-local.ps1 -Jdk 'C:\path\to\jdk-17' -BuildTools 'C:\path\to\android-sdk\build-tools\35.0.0' -AndroidJar 'C:\path\to\android-sdk\platforms\android-35\android.jar'
```

## Project structure

- `app/src/main/java/`: Android container, file export, and real GPS recording service.
- `app/src/main/java/com/runlab/app/KeepUploader.java`: Creation and sending of Keep upload requests.
- `app/src/main/assets/core.js`: Simulated activity generation and GPX/FIT export.
- `app/src/main/assets/app.js`: Route and parameter interface.
- `app/src/main/assets/shanghai/`: Derived offline map data for Shanghai.
- `tools/`: Scripts that generate the offline map from OpenStreetMap extracts.
- `REAL-DATA.md`: Raw GPS data format and limitations.

## Limitations

- The pedestrian network is based on OpenStreetMap tags and does not guarantee that a route is open in the real world. Strict pedestrian routing currently covers only the area around campus.
- Online map availability depends on your network connection and the map providers.
- The Keep upload uses an unofficial interface and may stop working after a Keep update. Never publish or share your login token.
- Simulated GPX/FIT files are intended for development and data research; they do not prove that physical activity occurred.
- Real recording depends on the phone's GPS and the operating system's background behavior. Continuous recording with the screen locked still needs testing on individual devices.
- This repository does not contain users' real running records, Keep account data, APKs, or signing keys. The character illustration icon was supplied by the project owner and is not licensed under the project's MIT License.

## Licenses and attribution

The project's original code is released under the MIT License; see [LICENSE](LICENSE). Some calculation and export design was adapted from [keep-data-sim](https://github.com/StringsLi/keep-data-sim); its [MIT license](LICENSE-upstream.txt) is retained. The map interface uses [Leaflet](https://leafletjs.com/), whose [BSD 2-Clause license](LICENSE-Leaflet.txt) is retained. The Shanghai offline map and campus pedestrian network are based on [OpenStreetMap](https://www.openstreetmap.org/copyright) data and are subject to ODbL 1.0; see [DATA-LICENSE.md](DATA-LICENSE.md).
