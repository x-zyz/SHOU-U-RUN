package top.apphub.account;

import android.content.Context;
import org.json.JSONObject;
import javax.net.ssl.HttpsURLConnection;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.URL;
import java.time.Instant;

public final class AppHubMembership {
    private static final String CLIENT_ID = "fce6a4bff367125ba2e071ccb9675d08";
    private static final String ENDPOINT = "https://api.0979019203.top/v1/apps/campus-run/membership";
    private static final String ACCOUNT = "account";

    private AppHubMembership() {}

    public enum Status { ACTIVE, SIGN_IN, NOT_MEMBER, UNAVAILABLE }

    public static final class Result {
        public final Status status;
        public final long expiresAtMillis;

        Result(Status status, long expiresAtMillis) {
            this.status = status;
            this.expiresAtMillis = expiresAtMillis;
        }
    }

    public static Result check(Context context) {
        AccountStore store = new AccountStore(context);
        String originalRefresh = null;
        try {
            JSONObject profile = store.read(ACCOUNT);
            if (profile == null) return result(Status.SIGN_IN);
            String idToken = profile.optString("id_token");
            if (!idToken.isEmpty() && profile.optLong("exp") > Instant.now().getEpochSecond() + 45) {
                Result current = fetch(idToken);
                if (current.status != Status.SIGN_IN) return current;
            }

            originalRefresh = profile.getString("refresh");
            JSONObject metadata = Oidc.discovery();
            JSONObject tokens = Oidc.refresh(metadata, CLIENT_ID, originalRefresh);
            idToken = tokens.getString("id_token");
            JSONObject claims = Oidc.verify(metadata, idToken, CLIENT_ID, null);
            Oidc.require(profile.getString("sub").equals(claims.getString("sub")), "Account changed");
            profile.put("id_token", idToken).put("exp", claims.getLong("exp"))
                    .put("refresh", tokens.optString("refresh_token", originalRefresh));
            if (!store.replaceAccount(originalRefresh, profile)) return result(Status.SIGN_IN);
            return fetch(idToken);
        } catch (Oidc.ServiceException error) {
            if (!error.invalidGrant) return result(Status.UNAVAILABLE);
            try {
                if (originalRefresh != null) store.replaceAccount(originalRefresh, null);
            } catch (Exception ignored) {}
            return result(Status.SIGN_IN);
        } catch (Exception error) {
            return result(Status.UNAVAILABLE);
        }
    }

    private static Result fetch(String token) throws Exception {
        HttpsURLConnection connection = (HttpsURLConnection) new URL(ENDPOINT).openConnection();
        connection.setInstanceFollowRedirects(false);
        connection.setConnectTimeout(8000);
        connection.setReadTimeout(8000);
        connection.setRequestProperty("Accept", "application/json");
        connection.setRequestProperty("Authorization", "Bearer " + token);
        try {
            int status = connection.getResponseCode();
            if (status == 401) return result(Status.SIGN_IN);
            if (status == 403) return result(Status.NOT_MEMBER);
            if (status != 200) return result(Status.UNAVAILABLE);
            JSONObject payload;
            try (InputStream input = connection.getInputStream(); ByteArrayOutputStream output = new ByteArrayOutputStream()) {
                byte[] chunk = new byte[512];
                for (int size; (size = input.read(chunk)) != -1; ) {
                    Oidc.require(output.size() + size <= 4096, "Invalid membership response");
                    output.write(chunk, 0, size);
                }
                payload = new JSONObject(output.toString("UTF-8"));
            }
            if (!payload.optBoolean("active") || !"member".equals(payload.optString("tier"))) return result(Status.NOT_MEMBER);
            long expiresAt = Instant.parse(payload.getString("expires_at")).toEpochMilli();
            return expiresAt > System.currentTimeMillis() ? new Result(Status.ACTIVE, expiresAt) : result(Status.NOT_MEMBER);
        } finally {
            connection.disconnect();
        }
    }

    private static Result result(Status status) {
        return new Result(status, 0);
    }
}
