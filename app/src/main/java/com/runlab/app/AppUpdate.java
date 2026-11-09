package com.runlab.app;

import android.app.Activity;
import android.app.DownloadManager;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.provider.Settings;
import java.io.InputStream;
import java.security.MessageDigest;
import java.util.function.Consumer;

final class AppUpdate {
    private static final String MIME = "application/vnd.android.package-archive";
    private static final String ROOT = "https://github.com/x-zyz/SHOU-U-RUN/releases/download/";
    private final Activity activity;
    private final Consumer<String> result;
    private boolean busy;

    AppUpdate(Activity activity, Consumer<String> result) {
        this.activity = activity;
        this.result = result;
    }

    void install(String tag, String hash) {
        if (busy) return;
        if (!tag.matches("v[0-9]{1,8}\\.[0-9]{1,8}\\.[0-9]{1,8}") || !hash.matches("[0-9a-f]{64}")) {
            result.accept("安装包信息无效。");
            return;
        }
        try {
            if (!activity.getPackageManager().canRequestPackageInstalls()) {
                activity.startActivity(new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                    Uri.parse("package:" + activity.getPackageName())));
                result.accept("允许安装未知应用后，返回并再次点「下载并安装」。");
                return;
            }
            busy = true;
            new Thread(() -> download(tag, hash), "app-update").start();
        } catch (RuntimeException failure) {
            finish("无法打开安装权限设置。", null);
        }
    }

    private void download(String tag, String hash) {
        DownloadManager manager = activity.getSystemService(DownloadManager.class);
        long id = -1;
        try {
            android.content.SharedPreferences prefs = activity.getSharedPreferences("app-update", Activity.MODE_PRIVATE);
            long previous = prefs.getLong("download", -1);
            if (previous != -1) manager.remove(previous);
            String name = "SHOU-U-RUN-" + tag + ".apk";
            DownloadManager.Request request = new DownloadManager.Request(Uri.parse(ROOT + tag + "/" + name))
                .setDestinationInExternalFilesDir(activity, null, name)
                .setTitle(name)
                .setMimeType(MIME)
                .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE);
            id = manager.enqueue(request);
            prefs.edit().putLong("download", id).apply();
            Uri apk = awaitDownload(manager, id);
            if (!verify(apk, hash)) throw new IllegalStateException("Checksum mismatch");
            finish("已校验下载，请在系统安装界面确认。", apk);
        } catch (Exception failure) {
            if (id != -1) {
                try { manager.remove(id); } catch (RuntimeException ignored) { }
            }
            finish("下载或校验失败，请重试。", null);
        }
    }

    private Uri awaitDownload(DownloadManager manager, long id) throws InterruptedException {
        long deadline = android.os.SystemClock.elapsedRealtime() + 300_000;
        while (!activity.isDestroyed() && android.os.SystemClock.elapsedRealtime() < deadline) {
            try (Cursor row = manager.query(new DownloadManager.Query().setFilterById(id))) {
                if (row == null || !row.moveToFirst()) break;
                int status = row.getInt(row.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS));
                if (status == DownloadManager.STATUS_SUCCESSFUL) return manager.getUriForDownloadedFile(id);
                if (status == DownloadManager.STATUS_FAILED) break;
            }
            Thread.sleep(1000);
        }
        throw new IllegalStateException("Download failed or timed out");
    }

    private boolean verify(Uri apk, String expected) throws Exception {
        if (apk == null) return false;
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        try (InputStream stream = activity.getContentResolver().openInputStream(apk)) {
            byte[] buffer = new byte[65536];
            for (int read; (read = stream.read(buffer)) != -1;) digest.update(buffer, 0, read);
        }
        StringBuilder actual = new StringBuilder();
        for (byte value : digest.digest()) actual.append(String.format(java.util.Locale.ROOT, "%02x", value & 0xff));
        return expected.contentEquals(actual);
    }

    private void finish(String message, Uri apk) {
        activity.runOnUiThread(() -> {
            busy = false;
            if (activity.isFinishing() || activity.isDestroyed()) return;
            try {
                if (apk != null) activity.startActivity(new Intent(Intent.ACTION_VIEW)
                    .setDataAndType(apk, MIME)
                    .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION));
                result.accept(message);
            } catch (RuntimeException failure) {
                result.accept("无法打开 Android 安装程序。");
            }
        });
    }
}
