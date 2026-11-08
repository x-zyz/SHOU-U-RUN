package com.runlab.app;

import android.content.Context;
import java.io.File;
import java.io.IOException;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.Iterator;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

final class KeepHistory {
 interface Result { void send(JSONObject value) throws Exception; }
 private interface Visitor { boolean visit(String id) throws Exception; }
 private final Context context;
 private String scanOwner;
 private final List<String> matches = new ArrayList<>();
 private static final String[] SAMPLE_FIELDS = {"stepPoints", "distanceSample", "calorieSample", "actionSample", "stepLengthAndFrequency"};
 private static final String[] ACTIVITY_FIELDS = {"distance", "duration", "totalSteps", "averageStepFrequency", "timezone", "privacy",
  "crossKmPoints", "specialDistancePoints", "calorie", "accumulativeUpliftedHeight"};
 private static final String[] POINT_FIELDS = {"timestamp", "unixTimestamp", "speed", "latitude", "longitude",
  "accuracyRadius", "currentTotalDistance", "isPause", "pause"};

 KeepHistory(Context context) { this.context = context; }
 static JSONObject event(String phase) throws JSONException { return new JSONObject().put("phase", phase); }

 private void visitHistory(KeepSessionStore.Session session, boolean includeDoubtful, Visitor visitor) throws Exception {
  long cursor = 0;
  Set<Long> cursors = new HashSet<>();
  Set<String> seen = new HashSet<>();
  do {
   if (!cursors.add(cursor)) throw new IOException("Keep 重复返回同一分页，扫描已停止。");
   JSONObject page = KeepUploader.read("/pd/v3/stats/detail?dateUnit=all&type=running&lastDate=" + cursor, session);
   JSONArray records = page.getJSONArray("records");
   for (int i = 0; i < records.length(); i++) {
    JSONObject record = records.optJSONObject(i);
    JSONArray logs = record == null ? null : record.optJSONArray("logs");
    if (logs == null) continue;
    for (int j = 0; j < logs.length(); j++) {
     JSONObject log = logs.optJSONObject(j);
     JSONObject stats = log == null ? null : log.optJSONObject("stats");
     if (stats == null || (!includeDoubtful && stats.optBoolean("isDoubtful"))) continue;
     String id = stats.optString("id", "");
     if (!id.matches("[A-Za-z0-9_-]{1,160}") || !seen.add(id)) continue;
     if (Thread.currentThread().isInterrupted()) throw new InterruptedException();
     if (!visitor.visit(id)) return;
     Thread.sleep(250);
    }
   }
   cursor = page.isNull("lastTimestamp") ? 0 : page.optLong("lastTimestamp", -1);
   if (cursor < 0) throw new IOException("Keep 历史分页游标无效。");
  } while (cursor != 0);
 }

 private static JSONObject detail(KeepSessionStore.Session session, String id) throws Exception {
  try { return KeepUploader.read("/pd/v3/runninglog/" + id, session); }
  catch (KeepUploader.HttpFailure e) { if (e.status == 404) return null; throw e; }
 }

 private static boolean outdoor(JSONObject run) {
  return run != null && "outdoorRunning".equals(run.optString("dataType"));
 }

 private static JSONArray points(JSONObject run) throws Exception {
  Object raw = run.opt("geoPoints");
  if (raw instanceof JSONArray) return (JSONArray) raw;
  if (!(raw instanceof String) || ((String)raw).isEmpty()) return new JSONArray();
  return KeepUploader.decodeSamples((String)raw, true);
 }

 private static JSONObject activity(JSONObject run) throws Exception {
  JSONArray geo = points(run);
  JSONArray normalized = new JSONArray();
  for (int i = 0; i < geo.length(); i++) {
   JSONObject point = geo.optJSONObject(i);
   if (point == null) continue;
   JSONObject sample = new JSONObject();
   for (String key : POINT_FIELDS) if (!point.isNull(key)) sample.put(key, point.get(key));
   normalized.put(sample);
  }
  return new JSONObject().put("source", "keep").put("dataType", "outdoorRunning")
   .put("startTime", run.opt("startTime")).put("endTime", run.opt("endTime"))
   .put("durationS", run.opt("duration")).put("distanceM", run.opt("distance")).put("points", normalized);
 }

 JSONObject importRuns(KeepSessionStore.Session session, boolean single, Result progress) throws Exception {
  final int[] scanned = {0}, size = {0};
  JSONArray activities = new JSONArray();
  visitHistory(session, false, id -> {
   if (!single) progress.send(event("progress").put("count", ++scanned[0]));
   JSONObject run = detail(session, id);
   if (!outdoor(run)) return true;
   JSONObject item;
   try { item = activity(run); }
   catch (JSONException | IOException error) { return true; }
   if (item.getJSONArray("points").length() < 2) return true;
   int length = item.toString().length();
   if (length > 4_000_000) return true;
   if (length + size[0] > 4_000_000) return false;
   activities.put(item);
   size[0] += length;
   return !single && activities.length() < 20;
  });
  if (single) {
   if (activities.length() == 0) return new JSONObject().put("ok", false).put("message", "没有找到可读取的 Keep 户外跑步。");
   return new JSONObject().put("ok", true).put("activity", activities.getJSONObject(0));
  }
  return event("done").put("activities", activities);
 }

 private static boolean isFileImport(JSONObject run) {
  for (JSONObject item : new JSONObject[]{run, run.optJSONObject("vendor")}) {
   if (item == null) continue;
   for (String key : new String[]{"source", "sourceName", "sourceLabel", "genre", "deviceModel", "trainingSource"}) {
    String value = item.optString(key, "").trim();
    if ("数据文件导入".equals(value) || "运动数据文件导入".equals(value)) return true;
    String compact = value.replaceAll("[^a-zA-Z0-9]", "").toLowerCase(Locale.ROOT);
    if (compact.matches("fileimport|importfile|datafileimport|sportdatafileimport")) return true;
   }
  }
  return false;
 }

 JSONObject scan(KeepSessionStore.Session session, Result progress) throws Exception {
  matches.clear();
  scanOwner = null;
  String owner = KeepUploader.readTokenClaims(session.token).getString("_id");
  List<String> found = new ArrayList<>();
  final int[] scanned = {0}, unavailable = {0};
  visitHistory(session, true, id -> {
   JSONObject run = detail(session, id);
   if (run == null) unavailable[0]++;
   else if (outdoor(run) && isFileImport(run)) found.add(id);
   progress.send(event("scanProgress").put("count", ++scanned[0]));
   return true;
  });
  matches.addAll(found);
  scanOwner = owner;
  return event("scanDone").put("scanned", scanned[0]).put("matched", found.size()).put("unavailable", unavailable[0]);
 }

 JSONObject convert(KeepSessionStore.Session session, Result progress) throws Exception {
  String owner = KeepUploader.readTokenClaims(session.token).getString("_id");
  if (!owner.equals(scanOwner) || matches.isEmpty()) throw new IOException("请先扫描当前账号的文件导入记录。");
  List<String> ids = new ArrayList<>(matches);
  scanOwner = null;
  matches.clear();
  int completed = 0, skipped = 0, held = 0;
  String failure = null;
  File directory = new File(context.getFilesDir(), "keep-conversion");
  if (!directory.isDirectory() && !directory.mkdirs() && !directory.isDirectory()) throw new IOException();
  for (String id : ids) {
   if (Thread.currentThread().isInterrupted()) throw new InterruptedException();
   File marker = new File(directory, KeepUploader.sha256Hex(owner + ":" + id));
   if (marker.exists()) {
    held++;
   } else {
    JSONObject run = detail(session, id);
    JSONObject payload = null;
    if (outdoor(run) && isFileImport(run)) {
     try { payload = rebuild(run, owner); }
     catch (JSONException | IOException error) { /* Unreadable activity stays untouched. */ }
    }
    if (payload == null) skipped++;
    else if (!marker.createNewFile()) held++;
    else {
     try {
      KeepUploader.uploadPayload(payload, session.token, session.deviceId);
      completed++;
     } catch (KeepUploader.HttpFailure error) {
      if (error.status == 401) throw error;
      held++;
      failure = error.getMessage();
      break;
     } catch (Exception error) {
      held++;
      failure = "提交结果无法确认，请在 Keep 核对。";
      break;
     }
     Thread.sleep(500);
    }
   }
   progress.send(batch("convertProgress", completed, skipped, held, ids.size(), null));
  }
  return batch("convertDone", completed, skipped, held, ids.size(), failure);
 }

 private static JSONObject batch(String phase, int completed, int skipped, int held, int total, String failure) throws JSONException {
  return event(phase).put("result", new JSONObject().put("Completed", completed).put("Skipped", skipped)
   .put("Held", held).put("Total", total).put("Failure", failure));
 }

 static JSONObject rebuild(JSONObject run, String owner) throws Exception {
  long start = run.getLong("startTime"), end = run.getLong("endTime");
  double distance = run.getDouble("distance"), duration = run.getDouble("duration");
  if (start < 978307200000L || end >= 4102444800000L || end <= start || end - start > 86400000 ||
      !Double.isFinite(distance) || distance <= 0 || !Double.isFinite(duration) || duration <= 0)
   throw new IOException("记录时间或距离无效。");
  JSONArray geo = points(run);
  if (geo.length() < 2 || geo.length() > 72000) throw new IOException("记录缺少可用轨迹。");
  shift(geo, start, end);
  JSONObject payload = new JSONObject().put("userID", owner).put("startTime", start - 15000).put("endTime", end - 15000)
   .put("trainType", "run").put("type", "run").put("subtype", "normal").put("dataType", "outdoorRunning")
   .put("clientVersion", "9.1.80").put("trainingSource", "RunningHelper").put("constantVersion", "130.40")
   .put("flags", new JSONArray("[421,95043,90,90,90]")).put("vendor", KeepUploader.appVendor())
   .put("geoPoints", KeepUploader.cbc(KeepUploader.compressBytes(geo.toString())))
   .put("timezone", "Asia/Shanghai").put("privacy", true)
   .put("crossKmPoints", new JSONArray()).put("specialDistancePoints", new JSONArray());
  for (String key : ACTIVITY_FIELDS) if (!run.isNull(key)) {
   Object value = run.get(key);
   shift(value, start, end);
   payload.put(key, value);
  }
  for (String key : SAMPLE_FIELDS) if (!run.isNull(key)) payload.put(key, shiftSamples(run.get(key), start, end));
  JSONObject heart = run.optJSONObject("heartRate");
  if (heart != null) {
   if (!heart.isNull("heartRates")) heart.put("heartRates", shiftSamples(heart.get("heartRates"), start, end));
   payload.put("heartRate", heart);
  }
  return payload;
 }

 private static Object shiftSamples(Object value, long start, long end) throws Exception {
  if (value instanceof String && !((String)value).isEmpty()) {
   JSONArray decoded = KeepUploader.decodeSamples((String)value, false);
   shift(decoded, start, end);
   return KeepUploader.compress(decoded.toString());
  }
  shift(value, start, end);
  return value;
 }

 private static void shift(Object value, long start, long end) throws JSONException {
  if (value instanceof JSONArray) {
   JSONArray array = (JSONArray)value;
   for (int i = 0; i < array.length(); i++) shift(array.opt(i), start, end);
  } else if (value instanceof JSONObject) {
   JSONObject object = (JSONObject)value;
   Iterator<String> keys = object.keys();
   while (keys.hasNext()) {
    String key = keys.next();
    Object item = object.opt(key);
    if (!key.matches("timestamp|unixTimestamp|timeAxis|time|startTime|endTime") || !(item instanceof Number || item instanceof String)) {
     shift(item, start, end);
     continue;
    }
    long stamp;
    try { stamp = Long.parseLong(item.toString()); } catch (NumberFormatException ignored) { continue; }
    for (long scale : new long[]{1, 100, 1000}) {
     if (stamp < (start - 86400000) / scale || stamp > (end + 86400000) / scale) continue;
     long shifted = stamp - 15000 / scale;
     object.put(key, item instanceof String ? Long.toString(shifted) : shifted);
     break;
    }
   }
  }
 }
}
