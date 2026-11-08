package com.runlab.app;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import org.json.JSONObject;

/** Local encrypted Keep session. All reads and writes run on the activity's worker. */
final class KeepSessionStore {
 private static final String PROVIDER = "AndroidKeyStore";
 private static final String KEY_ALIAS = "com.runlab.app.keep.session.v1";
 private static final String RECORD = "encrypted_session";
 private static final String CIPHER = "AES/GCM/NoPadding";
 private final SharedPreferences prefs;

 static final class Session {
  final String token, accountLabel, deviceId;

  Session(String token, String accountLabel, String deviceId) {
   this.token = token;
   this.accountLabel = accountLabel;
   this.deviceId = deviceId;
  }
 }

 KeepSessionStore(Context context) {
  prefs = context.getSharedPreferences("keep_session", Context.MODE_PRIVATE);
 }

 Session load() throws Exception {
  String record = prefs.getString(RECORD, null);
  if (record == null) return null;
  String[] parts = record.split("\\.", 2);
  if (parts.length != 2) throw new IOException("Invalid session record");
  SecretKey key = (SecretKey) keyStore().getKey(KEY_ALIAS, null);
  if (key == null) throw new IOException("Session key unavailable");
  Cipher cipher = Cipher.getInstance(CIPHER);
  byte[] iv = Base64.decode(parts[0], Base64.NO_WRAP);
  cipher.init(Cipher.DECRYPT_MODE, key, new GCMParameterSpec(128, iv));
  byte[] data = cipher.doFinal(Base64.decode(parts[1], Base64.NO_WRAP));
  JSONObject session = new JSONObject(new String(data, StandardCharsets.UTF_8));
  String token = session.getString("token");
  KeepUploader.readTokenClaims(token);
  return new Session(token, session.getString("account"), session.optString("device", null));
 }

 void save(Session session) throws Exception {
  SecretKey key = (SecretKey) keyStore().getKey(KEY_ALIAS, null);
  if (key == null) {
   KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, PROVIDER);
   generator.init(new KeyGenParameterSpec.Builder(KEY_ALIAS,
     KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
     .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
     .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
     .setKeySize(256)
     .build());
   key = generator.generateKey();
  }
  JSONObject data = new JSONObject().put("token", session.token)
    .put("account", session.accountLabel).put("device", session.deviceId);
  Cipher cipher = Cipher.getInstance(CIPHER);
  cipher.init(Cipher.ENCRYPT_MODE, key);
  byte[] encrypted = cipher.doFinal(data.toString().getBytes(StandardCharsets.UTF_8));
  String record = Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP) + "." +
    Base64.encodeToString(encrypted, Base64.NO_WRAP);
  if (!prefs.edit().putString(RECORD, record).commit()) throw new IOException("Session save failed");
 }

 boolean clear() {
  if (prefs.edit().remove(RECORD).commit()) return true;
  try {
   keyStore().deleteEntry(KEY_ALIAS);
   return true;
  } catch (Exception e) {
   return false;
  }
 }

 private static KeyStore keyStore() throws Exception {
  KeyStore keyStore = KeyStore.getInstance(PROVIDER);
  keyStore.load(null);
  return keyStore;
 }
}
