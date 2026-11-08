package com.runlab.app;

import android.content.Context;
import java.io.BufferedReader;
import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/** Extracts five-second speed averages. Coordinates and raw records stay in the native recorder. */
final class RunPaceSamples {
 private static final int WINDOW_SECONDS = 5;
 private static final int MAX_RECORDS = 20;
 private static final int MAX_WINDOWS = 2160;
 private static final long MAX_FILE_BYTES = 4L * 1024 * 1024;

 private RunPaceSamples() {}

 static JSONArray collect(Context context) {
  JSONArray runs = new JSONArray();
  File[] files = RunRecorderService.recordFiles(context);
  if (files == null) return runs;
  int remaining = MAX_WINDOWS;
  for (int i = 0; i < Math.min(MAX_RECORDS, files.length) && remaining > 0; i++) {
   File file = files[i];
   if (file.length() == 0 || file.length() > MAX_FILE_BYTES) continue;
   try {
    Windows run = read(file, remaining);
    if (run != null && run.count >= 3) {
     runs.put(run.segments);
     remaining -= run.count;
    }
   } catch (IOException | JSONException ignored) {
    // An unreadable record does not prevent using the other runs.
   }
  }
  return runs;
 }

 private static Windows read(File file, int limit) throws IOException, JSONException {
  try (BufferedReader input = new BufferedReader(new InputStreamReader(
      new FileInputStream(file), StandardCharsets.UTF_8))) {
   String first = input.readLine();
   if (first == null) return null;
   JSONObject header = new JSONObject(first);
   if (!"session".equals(header.optString("type")) || !"shou.real-gps.v1".equals(header.optString("schema"))
       || !"android_gps".equals(header.optString("source")) || header.optBoolean("synthetic", true)) return null;
   Windows windows = new Windows();
   double lastTime = -1, lastSpeed = 0;
   boolean paused = false;
   String line;
   while ((line = input.readLine()) != null) {
    JSONObject event = new JSONObject(line);
    String type = event.optString("type");
    if ("completed".equals(type)) {
     windows.split();
     return windows;
    }
    if ("error".equals(type) || "interrupted".equals(type)) return null;
    if ("pause".equals(type)) paused = true;
    if ("resume".equals(type)) paused = false;
    if (windows.count >= limit) continue;
    double time = event.optDouble("elapsed_ns", -1) / 1e9;
    double speed = event.optDouble("speed_mps", -1);
    double accuracy = event.optDouble("accuracy_m", -1);
    double speedAccuracy = event.optDouble("speed_accuracy_mps", Double.NaN);
    boolean valid = !paused && "fix".equals(type) && !event.optBoolean("mock", true)
      && "gps".equals(event.optString("provider")) && Double.isFinite(time) && time > 0
      && speed >= 1 && speed <= 6.5 && accuracy > 0 && accuracy <= 35
      && (Double.isNaN(speedAccuracy) || speedAccuracy >= 0 && speedAccuracy <= 1);
    double dt = time - lastTime;
    if (!valid || lastTime < 0 || dt <= 0 || dt > 3) windows.split();
    else windows.add(dt, (lastSpeed + speed) / 2);
    lastTime = valid ? time : -1;
    lastSpeed = speed;
   }
   return null;
  }
 }

 private static final class Windows {
  final JSONArray segments = new JSONArray();
  private JSONArray segment = new JSONArray();
  private double seconds, distance;
  int count;

  void split() {
   if (segment.length() > 0) {
    segments.put(segment);
    segment = new JSONArray();
   }
   seconds = distance = 0;
  }

  void add(double dt, double speed) throws JSONException {
   double used = Math.min(dt, WINDOW_SECONDS - seconds);
   seconds += used;
   distance += used * speed;
   if (seconds >= WINDOW_SECONDS) {
    segment.put(Math.round(distance / WINDOW_SECONDS * 1000) / 1000.0);
    count++;
    seconds = dt - used;
    distance = seconds * speed;
   }
  }
 }
}
