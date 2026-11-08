package com.runlab.app;

import android.util.Base64;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;
import java.io.ByteArrayOutputStream;
import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.util.zip.GZIPInputStream;
import java.util.zip.InflaterInputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.Locale;
import java.util.zip.GZIPOutputStream;
import javax.crypto.Cipher;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.IvParameterSpec;
import javax.crypto.spec.SecretKeySpec;
import javax.net.ssl.HttpsURLConnection;

/** Converts an in-memory activity to Keep's current sportlog request. No credentials are stored. */
final class KeepUploader {
 private static final String ENDPOINT = "https://api.gotokeep.com/pd/v5/sportlog";
 private static final String VERSION = "20240725.2";
 private static final byte[] CBC_KEY = "56fe59;82g:d873c".getBytes(StandardCharsets.UTF_8);
 private static final byte[] CBC_IV = "2346892432920300".getBytes(StandardCharsets.UTF_8);
 private KeepUploader() {}

 static String normalizeToken(String token) {
  return token == null ? "" : token.trim().replaceFirst("^Bearer\\s+", "");
 }

 static JSONObject readTokenClaims(String token) {
  String[] jwt = token.split("\\.", -1);
  if (token.length() > 16384 || jwt.length != 3 || jwt[0].isEmpty() || jwt[2].isEmpty()) {
   throw new IllegalArgumentException("Keep 登录凭证格式无效");
  }
  JSONObject claims;
  try {
   claims = new JSONObject(new String(Base64.decode(jwt[1], Base64.URL_SAFE | Base64.NO_WRAP), StandardCharsets.UTF_8));
  } catch (JSONException | IllegalArgumentException e) {
   throw new IllegalArgumentException("Keep 登录凭证格式无效");
  }
  if (!claims.optString("_id", "").matches("[a-fA-F0-9]{24}")) {
   throw new IllegalArgumentException("Keep 登录凭证缺少用户 ID");
  }
  if (claims.optLong("exp", 0) <= System.currentTimeMillis() / 1000L + 60L) {
   throw new IllegalArgumentException("Keep 登录凭证已经过期");
  }
  return claims;
 }

 static String upload(String activityJson, String rawToken, String sessionDeviceId) throws Exception {
  String token = normalizeToken(rawToken);
  String uid = readTokenClaims(token).getString("_id");
  JSONObject activity = new JSONObject(activityJson);
  JSONArray points = activity.getJSONArray("points");
  if (points.length() < 2 || points.length() > 72000 || activityJson.length() > 16000000) throw new IllegalArgumentException("轨迹点数量无效或记录过大");
  return uploadPayload(payload(activity, uid), token, sessionDeviceId);
 }

 static String uploadPayload(JSONObject payload, String token, String sessionDeviceId) throws Exception {
  String uid = readTokenClaims(token).getString("_id");
  String[] jwt = token.split("\\.");
  byte[] key = encryptionKey(uid);
  byte[] iv = new byte[12]; new SecureRandom().nextBytes(iv);
  Cipher gcm = Cipher.getInstance("AES/GCM/NoPadding");
  gcm.init(Cipher.ENCRYPT_MODE, new SecretKeySpec(key, "AES"), new GCMParameterSpec(128, iv));
  String iv64 = url64(iv);
  String envelope = iv64 + "." + url64(gcm.doFinal(payload.toString().getBytes(StandardCharsets.UTF_8))) + "." + sign(key, iv64 + "cNARa" + jwt[2]);
  String body = new JSONObject().put("enkzip", envelope).toString();
  String signature = sign(key, body + "/pd/v5/sportlog" + VERSION);
  HttpsURLConnection connection = connect(ENDPOINT, token, sessionDeviceId);
  try {
   connection.setRequestMethod("POST"); connection.setDoOutput(true);
   connection.setRequestProperty("x-sign", signature);
   connection.setRequestProperty("Content-Type", "application/json; charset=UTF-8");
   byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
   connection.setFixedLengthStreamingMode(bytes.length);
   try (OutputStream out = connection.getOutputStream()) { out.write(bytes); }
   JSONObject response = response(connection, 256000);
   if (!Boolean.TRUE.equals(response.opt("ok"))) throw new IllegalStateException("Keep 拒绝了记录" + errorCodeSuffix(response));
   return "Keep 已接受记录，请在 Keep 中核对结果";
  } finally { connection.disconnect(); }
 }

 private static HttpsURLConnection connect(String url, String token, String sessionDeviceId) throws Exception {
  String deviceId = sessionDeviceId != null ? sessionDeviceId : sha256Hex("keep:" + sha256Hex(token.toLowerCase(Locale.ROOT))).substring(0, 16);
  HttpsURLConnection connection = (HttpsURLConnection) new URL(url).openConnection();
  connection.setConnectTimeout(15000); connection.setReadTimeout(30000); connection.setInstanceFollowRedirects(false);
   connection.setRequestProperty("User-Agent", "Keep/9.1.80 (RunningHelper Desktop)");
   connection.setRequestProperty("x-version-name", "9.1.80");
   connection.setRequestProperty("x-version-code", "50178");
   connection.setRequestProperty("x-os", "Android");
   connection.setRequestProperty("x-app-platform", "keepapp");
   connection.setRequestProperty("x-locale", "zh-Hans-CN");
   connection.setRequestProperty("x-keep-timezone", "Asia/Shanghai");
   connection.setRequestProperty("x-is-guest", "N");
   connection.setRequestProperty("x-encrypt-code", VERSION);
   connection.setRequestProperty("x-device-id", deviceId);
   connection.setRequestProperty("x-timestamp", Long.toString(System.currentTimeMillis()));
   connection.setRequestProperty("Authorization", "Bearer " + token);
  return connection;
 }

 static final class HttpFailure extends IOException {
  final int status;
  HttpFailure(int status, JSONObject response) {
   super("Keep 返回 HTTP " + status + errorCodeSuffix(response));
   this.status = status;
  }
 }

 static JSONObject read(String path, KeepSessionStore.Session session) throws Exception {
  HttpsURLConnection conn = connect("https://api.gotokeep.com" + path, session.token, session.deviceId);
  try {
   JSONObject response = response(conn, 8_000_000);
   if (!Boolean.TRUE.equals(response.opt("ok"))) throw new IOException("Keep 拒绝了读取请求" + errorCodeSuffix(response));
   return response.getJSONObject("data");
  } finally { conn.disconnect(); }
 }

 private static JSONObject response(HttpsURLConnection conn, int max) throws Exception {
  int status = conn.getResponseCode();
  InputStream stream = status >= 400 ? conn.getErrorStream() : conn.getInputStream();
  JSONObject result = new JSONObject();
  if (stream != null) try (InputStream in = stream) {
   try { result = new JSONObject(new String(readBytes(in, max), StandardCharsets.UTF_8)); }
   catch (JSONException error) { if (status >= 200 && status < 300) throw error; }
  }
  if (status < 200 || status >= 300) throw new HttpFailure(status, result);
  return result;
 }

 private static byte[] readBytes(InputStream in, int max) throws IOException {
  ByteArrayOutputStream out = new ByteArrayOutputStream();
  byte[] buffer = new byte[8192];
  int read;
  while ((read = in.read(buffer)) != -1) {
   if (out.size() + read > max) throw new IOException("Keep 响应过大");
   out.write(buffer, 0, read);
  }
  return out.toByteArray();
 }

 static JSONArray decodeSamples(String encoded, boolean encrypted) throws IOException {
  if (encoded.length() > 24_000_000) throw new IOException("Keep 采样数据过大");
  try {
   byte[] raw = Base64.decode(encoded, Base64.DEFAULT);
   if (encrypted) {
    try {
     Cipher cipher = Cipher.getInstance("AES/CBC/PKCS5Padding");
     cipher.init(Cipher.DECRYPT_MODE, new SecretKeySpec(CBC_KEY, "AES"), new IvParameterSpec(CBC_IV));
     return decompressSamples(cipher.doFinal(raw));
    } catch (Exception ignored) { /* Some records contain plain compressed samples. */ }
   }
   return decompressSamples(raw);
  } catch (Exception error) { throw new IOException("Keep 采样无法解码"); }
 }

 private static JSONArray decompressSamples(byte[] raw) throws Exception {
  boolean gzip = raw.length > 1 && raw[0] == 31 && (raw[1] & 255) == 139;
  ByteArrayInputStream bytes = new ByteArrayInputStream(raw);
  try (InputStream in = gzip ? new GZIPInputStream(bytes) : new InflaterInputStream(bytes)) {
   return new JSONArray(new String(readBytes(in, 16_000_000), StandardCharsets.UTF_8));
  }
 }

 static JSONObject appVendor() throws JSONException {
  return new JSONObject().put("source", "keep").put("manufacturer", "keep").put("genre", "App")
   .put("deviceModel", "Keep App").put("vendorRecordId", JSONObject.NULL);
 }

 private static byte[] encryptionKey(String uid) throws Exception {
  // Rotate the user ID at index 13 before hashing it.
  return md5Hex(uid.substring(13) + uid.substring(0, 13)).getBytes(StandardCharsets.US_ASCII);
 }

 private static String errorCodeSuffix(JSONObject response) {
  if (response == null) return "";
  String code = response.optString("errorCode", response.optString("code", ""));
  return code.matches("[1-9][0-9]{0,9}") ? "（Keep 错误码 " + code + "）" : "";
 }

 static JSONObject payload(JSONObject a, String uid) throws Exception {
  JSONArray points = a.getJSONArray("points"), geo = new JSONArray(), steps = new JSONArray(), hearts = new JSONArray();
  long start = points.getJSONObject(0).getLong("time"), end = points.getJSONObject(points.length() - 1).getLong("time");
  double distance = a.getDouble("distance"), duration = a.getDouble("duration");
  if (!(distance > 0 && distance < 200000 && duration > 0 && duration < 86400) || end <= start) throw new IllegalArgumentException("运动距离或时间无效");
  double cumulativeSteps = 0, previousElapsed = 0;
  int calories = Math.max(1, (int)Math.round(distance * 0.072));
  for (int i = 0; i < points.length(); i++) {
   JSONObject p = points.getJSONObject(i);
   double lat = p.getDouble("lat"), lon = p.getDouble("lon"), elapsed = (p.getLong("time") - start) / 1000.0;
   if (!Double.isFinite(lat) || !Double.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180 || elapsed < previousElapsed) throw new IllegalArgumentException("轨迹坐标或时间无效");
   double cadence = p.optDouble("cadence", 160), speed = p.optDouble("speed", 2.2);
   if (!Double.isFinite(cadence) || !Double.isFinite(speed)) throw new IllegalArgumentException("运动指标无效");
   if (i > 0) cumulativeSteps += Math.max(0, cadence) * (elapsed - previousElapsed) / 60.0;
   previousElapsed = elapsed;
   int stepCount = (int)Math.round(cumulativeSteps), sampleCalories = (int)Math.round(calories * Math.max(0, p.optDouble("distance", 0)) / distance);
   int ticks = (int)Math.round(elapsed * 10), pace = i == 0 || speed <= 0 ? 0 : (int)Math.round(1000.0 / speed);
   JSONObject common = new JSONObject().put("timestamp", ticks).put("unixTimestamp", p.getLong("time"))
     .put("currentTotalDuration", (int)Math.round(elapsed)).put("currentTotalDistance", Math.round(p.optDouble("distance", 0) * 100.0) / 100.0)
     .put("currentTotalSteps", stepCount).put("currentTotalCalories", sampleCalories).put("isPause", false);
   steps.put(new JSONObject(common.toString()));
   double[] gcj = wgsToGcj(lat, lon);
   int stance = 250;
   JSONObject g = new JSONObject(common.toString()).put("latitude", gcj[0]).put("longitude", gcj[1]).put("altitude", p.optDouble("altitude", 0))
     .put("pressure", 0).put("accuracyRadius", 0).put("crossKmMark", 0).put("currentPace", pace).put("locationType", 1)
     .put("speed", i == 0 ? 0 : Math.round(speed * 36.0 * 1000.0) / 10000.0).put("flags", JSONObject.NULL).put("isStepPoint", false)
     .put("verticalAccuracy", 0).put("processLabel", 0).put("bearing", 0)
     .put("ctuh", stance).put("ctud", stance).put("ctdh", stance).put("ctdd", stance).put("sr", (int)Math.round(cadence))
     .put("sa", i == 0 ? JSONObject.NULL : Math.round(speed * 60.0 / Math.max(cadence, 1) * 100.0) / 100.0)
     .put("hs", JSONObject.NULL).put("gctd", stance).put("gctt", 100).put("ss", JSONObject.NULL).put("stepPoint", false).put("pause", false);
   geo.put(g);
   JSONObject h = new JSONObject(); if (i > 0) h.put("timestamp", ticks).put("timeAxis", ticks);
   hearts.put(h.put("beatsPerMinute", p.optInt("hr", 120)));
  }
  int totalSteps = (int)Math.round(cumulativeSteps), ascent = 0;
  for (int i = 1; i < points.length(); i++) ascent += Math.max(0, Math.round(points.getJSONObject(i).optDouble("altitude", 0) - points.getJSONObject(i-1).optDouble("altitude", 0)));
  String empty = compress(new JSONArray().toString());
  return new JSONObject().put("userID", uid).put("startTime", start).put("endTime", end).put("distance", Math.round(distance * 100.0) / 100.0)
    .put("duration", (int)Math.round(duration)).put("totalSteps", totalSteps).put("averageStepFrequency", totalSteps * 60.0 / duration)
    .put("trainType", "run").put("type", "run").put("subtype", "normal").put("dataType", "outdoorRunning")
    .put("timezone", "Asia/Shanghai").put("clientVersion", "9.1.80").put("trainingSource", "RunningHelper").put("privacy", false)
    .put("geoPoints", cbc(compressBytes(geo.toString()))).put("stepPoints", compress(steps.toString()))
    .put("crossKmPoints", new JSONArray()).put("specialDistancePoints", new JSONArray()).put("flags", new JSONArray("[421,95043,90,90,90]"))
    .put("constantVersion", "130.40").put("vendor", appVendor())
    .put("distanceSample", empty).put("calorieSample", empty).put("actionSample", empty).put("stepLengthAndFrequency", empty)
    .put("calorie", calories).put("accumulativeUpliftedHeight", ascent)
    .put("heartRate", new JSONObject().put("heartRates", compress(hearts.toString())));
 }

 static byte[] compressBytes(String value) throws Exception {
  ByteArrayOutputStream bytes = new ByteArrayOutputStream();
  try (GZIPOutputStream gz = new GZIPOutputStream(bytes)) { gz.write(value.getBytes(StandardCharsets.UTF_8)); }
  return bytes.toByteArray();
 }
 static String compress(String value) throws Exception { return Base64.encodeToString(compressBytes(value), Base64.NO_WRAP); }
 static String cbc(byte[] value) throws Exception {
  Cipher cipher = Cipher.getInstance("AES/CBC/PKCS5Padding"); cipher.init(Cipher.ENCRYPT_MODE, new SecretKeySpec(CBC_KEY, "AES"), new IvParameterSpec(CBC_IV));
  return Base64.encodeToString(cipher.doFinal(value), Base64.NO_WRAP);
 }
 private static String url64(byte[] data) { return Base64.encodeToString(data, Base64.URL_SAFE | Base64.NO_PADDING | Base64.NO_WRAP); }
 private static String sign(byte[] key, String value) throws Exception {
  MessageDigest digest = MessageDigest.getInstance("SHA-256"); digest.update(key); digest.update(value.getBytes(StandardCharsets.UTF_8));
  return url64(digest.digest()) + "A";
 }
 private static String md5Hex(String value) throws Exception {
  byte[] bytes = MessageDigest.getInstance("MD5").digest(value.getBytes(StandardCharsets.UTF_8));
  StringBuilder out = new StringBuilder(); for (byte b : bytes) out.append(String.format(Locale.ROOT, "%02x", b & 255)); return out.toString();
 }
 static String sha256Hex(String value) throws Exception {
  byte[] bytes = MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8));
  StringBuilder out = new StringBuilder(); for (byte b : bytes) out.append(String.format(Locale.ROOT, "%02x", b & 255)); return out.toString();
 }
 private static double[] wgsToGcj(double lat, double lon) {
  if (lon < 72.004 || lon > 137.8347 || lat < 0.8293 || lat > 55.8271) return new double[]{lat, lon};
  double x = lon - 105.0, y = lat - 35.0;
  double dLat = -100.0 + 2*x + 3*y + .2*y*y + .1*x*y + .2*Math.sqrt(Math.abs(x));
  dLat += (20*Math.sin(6*x*Math.PI) + 20*Math.sin(2*x*Math.PI))*2/3;
  dLat += (20*Math.sin(y*Math.PI) + 40*Math.sin(y*Math.PI/3))*2/3;
  dLat += (160*Math.sin(y*Math.PI/12) + 320*Math.sin(y*Math.PI/30))*2/3;
  double dLon = 300.0 + x + 2*y + .1*x*x + .1*x*y + .1*Math.sqrt(Math.abs(x));
  dLon += (20*Math.sin(6*x*Math.PI) + 20*Math.sin(2*x*Math.PI))*2/3;
  dLon += (20*Math.sin(x*Math.PI) + 40*Math.sin(x*Math.PI/3))*2/3;
  dLon += (150*Math.sin(x*Math.PI/12) + 300*Math.sin(x*Math.PI/30))*2/3;
  double rad = lat/180*Math.PI, magic = 1 - .00669342162296594323*Math.sin(rad)*Math.sin(rad);
  return new double[]{lat + dLat*180/((6335552.717000426/(magic*Math.sqrt(magic)))*Math.PI), lon + dLon*180/(6378245.0/Math.sqrt(magic)*Math.cos(rad)*Math.PI)};
 }
}
