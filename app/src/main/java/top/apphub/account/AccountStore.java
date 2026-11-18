package top.apphub.account;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import org.json.JSONObject;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.util.Arrays;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

final class AccountStore {
    private static final String ALIAS = "apphub-oidc-aes-v1";
    private final SharedPreferences preferences;

    AccountStore(Context context) {
        preferences = context.getSharedPreferences("apphub-oidc", Context.MODE_PRIVATE);
    }

    JSONObject read(String field) throws Exception {
        String saved = preferences.getString(field, null);
        if (saved == null) return null;
        byte[] blob = Base64.decode(saved, Base64.NO_WRAP);
        Oidc.require(blob.length > 28, "Invalid stored account record");
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, key(false), new GCMParameterSpec(128, Arrays.copyOf(blob, 12)));
        cipher.updateAAD(field.getBytes(StandardCharsets.UTF_8));
        return new JSONObject(new String(cipher.doFinal(blob, 12, blob.length - 12), StandardCharsets.UTF_8));
    }

    void save(String field, JSONObject value) throws Exception {
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, key(true));
        cipher.updateAAD(field.getBytes(StandardCharsets.UTF_8));
        byte[] iv = cipher.getIV();
        Oidc.require(iv.length == 12, "Unexpected storage IV");
        byte[] encrypted = cipher.doFinal(value.toString().getBytes(StandardCharsets.UTF_8));
        byte[] blob = Arrays.copyOf(iv, iv.length + encrypted.length);
        System.arraycopy(encrypted, 0, blob, iv.length, encrypted.length);
        Oidc.require(preferences.edit().putString(field, Base64.encodeToString(blob, Base64.NO_WRAP)).commit(),
                "Account record could not be saved");
    }

    void remove(String field) throws Exception {
        Oidc.require(preferences.edit().remove(field).commit(), "Account record could not be cleared");
    }

    private static synchronized SecretKey key(boolean create) throws Exception {
        KeyStore keyStore = KeyStore.getInstance("AndroidKeyStore");
        keyStore.load(null);
        if (keyStore.containsAlias(ALIAS)) return (SecretKey) keyStore.getKey(ALIAS, null);
        Oidc.require(create, "Device account key is missing");
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        generator.init(new KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build());
        return generator.generateKey();
    }
}
