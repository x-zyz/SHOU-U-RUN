package top.apphub.account;

import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Bundle;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import org.json.JSONObject;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public final class AppHubActivity extends Activity {
    private static final String ID_KEY = "top.apphub.account.CLIENT_ID";
    private static final String REDIRECT_KEY = "top.apphub.account.REDIRECT_URI";
    private static final String LOGIN = "login";
    private static final String ACCOUNT = "account";
    private static final long TIMEOUT_MS = 10 * 60 * 1000;
    private final ExecutorService executor = Executors.newSingleThreadExecutor();
    private AccountStore store;
    private String clientId;
    private String redirect;
    private String notice = "";
    private boolean busy;

    public static void open(Activity activity) {
        activity.startActivity(new Intent(activity, AppHubActivity.class));
    }

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        store = new AccountStore(this);
        try {
            Bundle data = getPackageManager().getApplicationInfo(getPackageName(), PackageManager.GET_META_DATA).metaData;
            clientId = data.getString(ID_KEY);
            redirect = data.getString(REDIRECT_KEY);
            Oidc.require(clientId != null && clientId.matches("[a-f0-9]{32}") && redirect != null
                    && redirect.matches("https://apps[.]0979019203[.]top/oauth/android/[a-z-]+/callback"),
                    "App Hub configuration missing");
        } catch (Exception failure) {
            clientId = null;
            notice = "此版本未配置 App Hub 登录。";
        }
        render();
        acceptCallback(getIntent());
    }

    @Override protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        acceptCallback(intent);
    }

    @Override protected void onDestroy() {
        executor.shutdown();
        super.onDestroy();
    }

    private void acceptCallback(Intent intent) {
        Uri uri = intent.getData();
        if (clientId == null || uri == null || !uri.isHierarchical() || !Intent.ACTION_VIEW.equals(intent.getAction())) return;
        if (!redirect.equals(uri.buildUpon().clearQuery().fragment(null).build().toString())
                || uri.getEncodedFragment() != null || busy) return;
        setIntent(new Intent(this, AppHubActivity.class));
        try {
            JSONObject pending = store.read(LOGIN);
            String state = parameter(uri, "state");
            long age = pending == null ? -1 : System.currentTimeMillis() - pending.getLong("created");
            Oidc.require(pending != null && age >= 0 && age <= TIMEOUT_MS
                    && state != null && MessageDigest.isEqual(state.getBytes(StandardCharsets.UTF_8),
                    pending.getString("state").getBytes(StandardCharsets.UTF_8)), "Unexpected callback");
            store.remove(LOGIN);
            String error = parameter(uri, "error");
            if (error != null) {
                notice = "登录已取消或被拒绝。";
                render();
                return;
            }
            String code = parameter(uri, "code");
            Oidc.require(code != null && !code.isEmpty() && code.length() < 4096, "Missing authorization code");
            work(() -> {
                JSONObject metadata = Oidc.discovery();
                JSONObject token = Oidc.exchange(metadata, clientId, redirect, code, pending.getString("verifier"));
                JSONObject claims = Oidc.verify(metadata, token.getString("id_token"), clientId, pending.getString("nonce"));
                store.save(ACCOUNT, account(claims, token));
                return "登录成功。";
            }, "登录未完成，请重试。");
        } catch (Exception failure) {
            notice = "该登录回调已失效，请重新登录。";
            render();
        }
    }

    private static String parameter(Uri uri, String key) throws Exception {
        List<String> values = uri.getQueryParameters(key);
        Oidc.require(values.size() < 2, "Duplicate authorization parameter");
        return values.isEmpty() ? null : values.get(0);
    }

    private void begin() {
        work(() -> {
            JSONObject metadata = Oidc.discovery();
            String state = Oidc.random(), nonce = Oidc.random(), verifier = Oidc.random();
            Uri authorize = Uri.parse(metadata.getString("authorization_endpoint")).buildUpon()
                    .appendQueryParameter("client_id", clientId)
                    .appendQueryParameter("response_type", "code")
                    .appendQueryParameter("redirect_uri", redirect)
                    .appendQueryParameter("scope", "openid profile email")
                    .appendQueryParameter("state", state)
                    .appendQueryParameter("nonce", nonce)
                    .appendQueryParameter("code_challenge", Oidc.sha256(verifier))
                    .appendQueryParameter("code_challenge_method", "S256")
                    .build();
            store.save(LOGIN, new JSONObject().put("state", state).put("nonce", nonce)
                    .put("verifier", verifier).put("created", System.currentTimeMillis()));
            runOnUiThread(() -> {
                if (isDestroyed() || isFinishing()) return;
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, authorize).addCategory(Intent.CATEGORY_BROWSABLE));
                } catch (android.content.ActivityNotFoundException failure) {
                    notice = "请先安装可用的浏览器。";
                    render();
                }
            });
            return "请在浏览器完成登录。若未自动回到应用，请检查系统中的默认打开链接设置。";
        }, "暂时无法连接账号服务。");
    }

    private static JSONObject account(JSONObject claims, JSONObject token) throws Exception {
        String subject = claims.getString("sub");
        return new JSONObject().put("sub", subject).put("name", claims.optString("name", subject))
                .put("email", claims.optString("email")).put("exp", claims.getLong("exp"))
                .put("refresh", token.getString("refresh_token"));
    }

    private void sync(JSONObject saved) {
        work(() -> {
            try {
                JSONObject metadata = Oidc.discovery();
                JSONObject tokens = Oidc.refresh(metadata, clientId, saved.getString("refresh"));
                JSONObject claims = Oidc.verify(metadata, tokens.getString("id_token"), clientId, null);
                Oidc.require(saved.getString("sub").equals(claims.getString("sub")), "Account changed");
                store.save(ACCOUNT, account(claims, tokens));
                return "登录状态已验证。";
            } catch (Oidc.ServiceException failure) {
                if (!failure.invalidGrant) throw failure;
                store.remove(ACCOUNT);
                return "登录已失效，请重新登录。";
            }
        }, "暂时无法验证登录状态。");
    }

    private void signOut(JSONObject saved) {
        work(() -> {
            store.remove(ACCOUNT);
            store.remove(LOGIN);
            try {
                Oidc.revoke(clientId, saved.getString("refresh"));
                return "已退出此应用。";
            } catch (Exception failure) {
                return "已清除本机登录。暂未能撤销服务器会话。";
            }
        }, "暂时无法清除本机登录。");
    }

    private interface Action { String run() throws Exception; }

    private void work(Action action, String error) {
        if (busy) return;
        busy = true;
        render();
        executor.execute(() -> {
            String result;
            try { result = action.run(); }
            catch (Exception failure) { result = error; }
            String message = result;
            runOnUiThread(() -> {
                if (isDestroyed() || isFinishing()) return;
                busy = false;
                notice = message;
                render();
            });
        });
    }

    private void render() {
        JSONObject saved = null;
        try { saved = store.read(ACCOUNT); }
        catch (Exception failure) {
            try { store.remove(ACCOUNT); } catch (Exception ignored) {}
        }
        ScrollView scroll = new ScrollView(this);
        LinearLayout content = new LinearLayout(this);
        content.setOrientation(LinearLayout.VERTICAL);
        int padding = (int) (20 * getResources().getDisplayMetrics().density);
        content.setPadding(padding, padding, padding, padding);
        scroll.addView(content);
        setContentView(scroll);
        addText(content, "App Hub 账号", 25);
        addText(content, "登录用于统一身份。本机数据可离线使用。", 15);
        if (saved != null) {
            final JSONObject profile = saved;
            String name = saved.optString("name").trim();
            if (!name.isEmpty()) addText(content, name, 20);
            if (!saved.optString("email").isEmpty()) addText(content, saved.optString("email"), 15);
            addText(content, saved.optLong("exp") > System.currentTimeMillis() / 1000 ? "已登录" : "本机账号记录 · 需要验证", 14);
            addButton(content, "验证登录状态", () -> sync(profile), clientId != null);
            addButton(content, "退出此应用", () -> signOut(profile), clientId != null);
        } else {
            addButton(content, "在浏览器登录", this::begin, clientId != null);
        }
        if (busy) addText(content, "正在连接账号服务…", 14);
        else if (!notice.isEmpty()) addText(content, notice, 14);
        addButton(content, "返回", this::finish, true);
    }

    private void addText(LinearLayout parent, String text, int size) {
        TextView view = new TextView(this);
        view.setTextSize(size);
        view.setText(text);
        view.setPadding(0, 0, 0, 12);
        parent.addView(view);
    }

    private void addButton(LinearLayout parent, String label, Runnable action, boolean enabled) {
        Button button = new Button(this);
        button.setText(label);
        button.setEnabled(enabled && !busy);
        button.setOnClickListener(view -> action.run());
        parent.addView(button, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
    }
}
