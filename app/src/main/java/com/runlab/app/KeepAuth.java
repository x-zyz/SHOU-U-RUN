package com.runlab.app;

import android.os.SystemClock;
import android.util.Base64;
import org.json.JSONObject;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Locale;
import javax.crypto.Cipher;
import javax.crypto.spec.IvParameterSpec;
import javax.crypto.spec.SecretKeySpec;
import javax.net.ssl.HttpsURLConnection;

/** One in-memory Keep SMS login attempt. The verification code and token are never persisted. */
final class KeepAuth {
 private static final String HOST = "https://api.gotokeep.com";
 private static final String LEGACY_SALT = "V1QiLCJhbGciOiJIUzI1NiJ9";
 private static final byte[] CBC_KEY = "56fe59;82g:d873c".getBytes(StandardCharsets.UTF_8);
 private static final byte[] CBC_IV = "2346892432920300".getBytes(StandardCharsets.UTF_8);
 final String phone;
 final String deviceId;
 private long smsExpiresAt;

 static final class Failure extends Exception {
  Failure(String message) { super(message); }
 }

 KeepAuth(String phone) throws Exception {
  if (phone == null || !phone.matches("1[3-9][0-9]{9}")) throw new Failure("请输入 11 位中国大陆手机号");
  this.phone = phone;
  deviceId = sha256Hex("keep:" + sha256Hex(phone.toLowerCase(Locale.ROOT))).substring(0, 16);
 }

 void sendSms() throws Exception {
  long now = System.currentTimeMillis();
  JSONObject login = new JSONObject().put("countryCode", "86").put("mobile", phone).put("countryName", "CHN")
    .put("time", Long.toString(now)).put("type", "registerLogin");
  JSONObject body = new JSONObject().put("body", cbc(login.toString().getBytes(StandardCharsets.UTF_8)));
  request("/account/v2/sms", body);
  smsExpiresAt = SystemClock.elapsedRealtime() + 10 * 60 * 1000;
 }

 String verifySms(String code) throws Exception {
  if (smsExpiresAt == 0 || SystemClock.elapsedRealtime() >= smsExpiresAt) throw new Failure("请先发送新的验证码");
  if (code == null || !code.matches("[0-9]{4,8}")) throw new Failure("请输入收到的短信验证码");
  JSONObject body = new JSONObject().put("androidId", deviceId).put("captcha", code).put("countryCode", "86")
    .put("countryName", "CHN").put("mobile", phone).put("type", "login");
  JSONObject result = request("/account/v3/login/sms", body);
  JSONObject data = result.optJSONObject("data");
  if (data == null && result.opt("data") instanceof String) {
   Cipher cipher = Cipher.getInstance("AES/CBC/PKCS5Padding");
   cipher.init(Cipher.DECRYPT_MODE, new SecretKeySpec(CBC_KEY, "AES"), new IvParameterSpec(CBC_IV));
   data = new JSONObject(new String(cipher.doFinal(Base64.decode(result.getString("data"), Base64.DEFAULT)), StandardCharsets.UTF_8));
  }
  String token = data == null ? "" : data.optString("token", "");
  String[] parts = token.split("\\.");
  if (parts.length != 3) throw new Failure("Keep 未返回有效登录凭证");
  JSONObject claims = new JSONObject(new String(Base64.decode(parts[1], Base64.URL_SAFE | Base64.NO_WRAP), StandardCharsets.UTF_8));
  if (!claims.optString("_id", "").matches("[a-fA-F0-9]{24}") || claims.optLong("exp", 0) * 1000L <= System.currentTimeMillis() + 60000L)
   throw new Failure("Keep 登录凭证无效或已过期");
  smsExpiresAt = 0;
  return token;
 }

 static String legacySign(String url, String body) throws Exception {
  String path = new URL(url).getPath();
  String md5 = md5Hex(body + path + LEGACY_SALT);
  long sum = 0;
  for (int i = 0; i < 32; i += 8) sum += Long.parseLong(md5.substring(i, i + 8), 16);
  long check = (sum + 929L * 286331153L) & 0xffffffffL;
  return md5 + String.format(Locale.ROOT, "%08x", check);
 }

 private JSONObject request(String path, JSONObject data) throws Exception {
  String body = data.toString(), url = HOST + path;
  HttpsURLConnection connection = (HttpsURLConnection) new URL(url).openConnection();
  try {
   connection.setRequestMethod("POST"); connection.setConnectTimeout(15000); connection.setReadTimeout(25000);
   connection.setInstanceFollowRedirects(false); connection.setDoOutput(true);
   connection.setRequestProperty("User-Agent", "Keep/9.1.80 (RunningHelper Desktop)");
   connection.setRequestProperty("x-version-name", "9.1.80"); connection.setRequestProperty("x-version-code", "50178");
   connection.setRequestProperty("x-os", "Android"); connection.setRequestProperty("x-app-platform", "keepapp");
   connection.setRequestProperty("x-locale", "zh-Hans-CN"); connection.setRequestProperty("x-keep-timezone", "Asia/Shanghai");
   connection.setRequestProperty("x-is-guest", "N"); connection.setRequestProperty("x-encrypt-code", "20240725.2");
   connection.setRequestProperty("x-device-id", deviceId); connection.setRequestProperty("x-timestamp", Long.toString(System.currentTimeMillis()));
   connection.setRequestProperty("sign", legacySign(url, body));
   connection.setRequestProperty("Content-Type", "application/json; charset=UTF-8");
   byte[] bytes = body.getBytes(StandardCharsets.UTF_8); connection.setFixedLengthStreamingMode(bytes.length);
   try (OutputStream out = connection.getOutputStream()) { out.write(bytes); }
   int status = connection.getResponseCode();
   InputStream stream = status >= 400 ? connection.getErrorStream() : connection.getInputStream();
   ByteArrayOutputStream result = new ByteArrayOutputStream();
   if (stream != null) try (InputStream in = stream) {
    byte[] buffer = new byte[4096]; int n;
    while ((n = in.read(buffer)) != -1) { result.write(buffer, 0, n); if (result.size() > 256000) throw new IllegalStateException("Keep 响应过大"); }
   }
   if (status < 200 || status >= 300) throw new Failure("Keep 登录接口返回 HTTP " + status);
   JSONObject response = new JSONObject(result.toString("UTF-8"));
   if (!response.optBoolean("ok", false)) {
    String code = response.optString("errorCode", "");
    throw new Failure(code.matches("[0-9]{1,10}") ? "Keep 拒绝登录请求（代码 " + code + "）" : "Keep 拒绝登录请求");
   }
   return response;
  } finally { connection.disconnect(); }
 }

 private static String cbc(byte[] data) throws Exception {
  Cipher cipher = Cipher.getInstance("AES/CBC/PKCS5Padding");
  cipher.init(Cipher.ENCRYPT_MODE, new SecretKeySpec(CBC_KEY, "AES"), new IvParameterSpec(CBC_IV));
  return Base64.encodeToString(cipher.doFinal(data), Base64.NO_WRAP);
 }
 private static String sha256Hex(String value) throws Exception { return hex(MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8))); }
 private static String md5Hex(String value) throws Exception { return hex(MessageDigest.getInstance("MD5").digest(value.getBytes(StandardCharsets.UTF_8))); }
 private static String hex(byte[] bytes) { StringBuilder out = new StringBuilder(); for (byte b : bytes) out.append(String.format(Locale.ROOT, "%02x", b & 255)); return out.toString(); }
}
