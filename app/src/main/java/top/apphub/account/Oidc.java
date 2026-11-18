package top.apphub.account;

import android.net.Uri;
import android.util.Base64;
import org.json.JSONArray;
import org.json.JSONObject;
import javax.net.ssl.HttpsURLConnection;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.KeyFactory;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.security.Signature;
import java.security.spec.RSAPublicKeySpec;
import java.math.BigInteger;
import java.util.LinkedHashMap;
import java.util.Map;

final class Oidc {
    static final String ISSUER = "https://id.0979019203.top";
    private static final SecureRandom RANDOM = new SecureRandom();
    private static final int BASE64 = Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING;

    private Oidc() {}

    static String random() {
        byte[] bytes = new byte[32];
        RANDOM.nextBytes(bytes);
        return Base64.encodeToString(bytes, BASE64);
    }

    static String sha256(String value) throws GeneralSecurityException {
        return Base64.encodeToString(MessageDigest.getInstance("SHA-256")
                .digest(value.getBytes(StandardCharsets.US_ASCII)), BASE64);
    }

    static JSONObject discovery() throws Exception {
        JSONObject metadata = read(ISSUER + "/.well-known/openid-configuration", null);
        require(ISSUER.equals(metadata.getString("issuer")), "Issuer mismatch");
        require(hasValue(metadata.optJSONArray("code_challenge_methods_supported"), "S256"), "PKCE unavailable");
        for (String name : new String[]{"authorization_endpoint", "token_endpoint", "jwks_uri", "revocation_endpoint"}) {
            endpoint(metadata.getString(name));
        }
        return metadata;
    }

    static JSONObject exchange(JSONObject metadata, String clientId, String redirectUri, String code,
                               String verifier) throws Exception {
        Map<String, String> parameters = new LinkedHashMap<>();
        parameters.put("grant_type", "authorization_code");
        parameters.put("client_id", clientId);
        parameters.put("redirect_uri", redirectUri);
        parameters.put("code", code);
        parameters.put("code_verifier", verifier);
        return read(metadata.getString("token_endpoint"), parameters);
    }

    static JSONObject refresh(JSONObject metadata, String clientId, String refreshToken) throws Exception {
        Map<String, String> parameters = new LinkedHashMap<>();
        parameters.put("grant_type", "refresh_token");
        parameters.put("client_id", clientId);
        parameters.put("refresh_token", refreshToken);
        return read(metadata.getString("token_endpoint"), parameters);
    }

    static void revoke(String clientId, String refreshToken) throws Exception {
        Map<String, String> parameters = new LinkedHashMap<>();
        parameters.put("client_id", clientId);
        parameters.put("token", refreshToken);
        parameters.put("token_type_hint", "refresh_token");
        read(discovery().getString("revocation_endpoint"), parameters);
    }

    static JSONObject verify(JSONObject metadata, String token, String clientId, String nonce) throws Exception {
        require(token.length() < 65536, "ID token too long");
        String[] fields = token.split("\\.", -1);
        require(fields.length == 3, "Invalid ID token");
        JSONObject header = decode(fields[0]);
        require("RS256".equals(header.getString("alg")) && !header.has("crit"), "Unsupported signature");
        String kid = header.getString("kid");
        require(!kid.isEmpty(), "Missing signing key");
        JSONArray keys = read(metadata.getString("jwks_uri"), null).getJSONArray("keys");
        JSONObject jwk = null;
        for (int i = 0; i < keys.length(); i++) {
            JSONObject key = keys.getJSONObject(i);
            if (kid.equals(key.optString("kid"))) {
                require(jwk == null, "Ambiguous signing key");
                jwk = key;
            }
        }
        require(jwk != null && "RSA".equals(jwk.optString("kty")) && "sig".equals(jwk.optString("use", "sig"))
                && "RS256".equals(jwk.optString("alg", "RS256")), "Unexpected signing key");
        BigInteger modulus = new BigInteger(1, Base64.decode(jwk.getString("n"), BASE64));
        BigInteger exponent = new BigInteger(1, Base64.decode(jwk.getString("e"), BASE64));
        require(modulus.bitLength() >= 2048 && modulus.bitLength() <= 8192, "Invalid RSA key size");
        Signature verifier = Signature.getInstance("SHA256withRSA");
        verifier.initVerify(KeyFactory.getInstance("RSA").generatePublic(new RSAPublicKeySpec(modulus, exponent)));
        verifier.update((fields[0] + "." + fields[1]).getBytes(StandardCharsets.US_ASCII));
        require(verifier.verify(Base64.decode(fields[2], BASE64)), "Invalid ID token signature");

        JSONObject claims = decode(fields[1]);
        require(ISSUER.equals(claims.getString("iss")), "Invalid ID token issuer");
        Object audience = claims.get("aud");
        if (audience instanceof JSONArray) {
            JSONArray entries = (JSONArray) audience;
            require(hasValue(entries, clientId) && (entries.length() == 1 || clientId.equals(claims.optString("azp"))),
                    "Invalid ID token audience");
        } else {
            require(clientId.equals(audience), "Invalid ID token audience");
        }
        require(!claims.has("azp") || clientId.equals(claims.getString("azp")), "Invalid authorized party");
        require(nonce == null || nonce.equals(claims.getString("nonce")), "Invalid ID token nonce");
        long now = System.currentTimeMillis() / 1000;
        require(claims.getLong("exp") > now && claims.getLong("iat") <= now + 60
                && (!claims.has("nbf") || claims.getLong("nbf") <= now + 60), "Invalid ID token time");
        require(!claims.getString("sub").isEmpty(), "Missing account identifier");
        return claims;
    }

    static URL endpoint(String address) throws Exception {
        Uri uri = Uri.parse(address);
        require("https".equals(uri.getScheme()) && "id.0979019203.top".equals(uri.getEncodedAuthority())
                && uri.getEncodedUserInfo() == null && uri.getEncodedQuery() == null
                && uri.getEncodedFragment() == null && uri.getPath() != null, "Untrusted OIDC endpoint");
        return new URL(address);
    }

    private static JSONObject read(String url, Map<String, String> parameters) throws Exception {
        HttpsURLConnection connection = (HttpsURLConnection) endpoint(url).openConnection();
        connection.setInstanceFollowRedirects(false);
        connection.setConnectTimeout(10000);
        connection.setReadTimeout(12000);
        connection.setRequestProperty("Accept", "application/json");
        try {
            if (parameters != null) {
                StringBuilder form = new StringBuilder();
                for (Map.Entry<String, String> entry : parameters.entrySet()) {
                    if (form.length() != 0) form.append('&');
                    form.append(entry.getKey()).append('=').append(URLEncoder.encode(entry.getValue(), "UTF-8"));
                }
                byte[] bytes = form.toString().getBytes(StandardCharsets.UTF_8);
                connection.setRequestMethod("POST");
                connection.setDoOutput(true);
                connection.setFixedLengthStreamingMode(bytes.length);
                connection.setRequestProperty("Content-Type", "application/x-www-form-urlencoded");
                try (java.io.OutputStream output = connection.getOutputStream()) { output.write(bytes); }
            }
            int status = connection.getResponseCode();
            if (status == 204) return new JSONObject();
            try (InputStream response = status == 200 ? connection.getInputStream() : connection.getErrorStream()) {
                JSONObject body = decodeResponse(response);
                if (status != 200 || body.has("error")) {
                    throw new ServiceException("invalid_grant".equals(body.optString("error")));
                }
                return body;
            }
        } finally {
            connection.disconnect();
        }
    }

    private static JSONObject decodeResponse(InputStream input) throws Exception {
        if (input == null) return new JSONObject();
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        byte[] chunk = new byte[4096];
        for (int n; (n = input.read(chunk)) != -1; ) {
            if (output.size() + n > 524288) throw new IOException("OIDC response too large");
            output.write(chunk, 0, n);
        }
        return output.size() == 0 ? new JSONObject() : new JSONObject(output.toString("UTF-8"));
    }

    private static boolean hasValue(JSONArray list, String value) throws Exception {
        if (list == null) return false;
        for (int i = 0; i < list.length(); i++) if (value.equals(list.getString(i))) return true;
        return false;
    }

    private static JSONObject decode(String value) throws Exception {
        return new JSONObject(new String(Base64.decode(value, BASE64), StandardCharsets.UTF_8));
    }

    static void require(boolean condition, String message) throws GeneralSecurityException {
        if (!condition) throw new GeneralSecurityException(message);
    }

    static final class ServiceException extends IOException {
        final boolean invalidGrant;
        ServiceException(boolean invalidGrant) {
            super("OIDC service rejected the request");
            this.invalidGrant = invalidGrant;
        }
    }
}
