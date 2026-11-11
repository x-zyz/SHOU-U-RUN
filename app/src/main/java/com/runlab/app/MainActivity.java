package com.runlab.app;
import android.app.*;import android.os.*;import android.content.*;import android.net.Uri;import android.webkit.*;import android.graphics.Color;import android.util.Base64;import java.io.*;import java.net.*;import java.util.concurrent.*;import org.json.*;
public class MainActivity extends Activity {
 private WebView web;private byte[] pending;private String recorderPermissionAction=null;private boolean realExport=false;private final ExecutorService pool=Executors.newSingleThreadExecutor();
 private KeepAuth keepAuth;
 private final AppUpdate appUpdate = new AppUpdate(this,
    message -> js("window.onUpdateResult(" + JSONObject.quote(message) + ")"));
 private long nextKeepSmsAt;
 private KeepSessionStore keepStore;
 private volatile KeepSessionStore.Session keepSession;

 @Override public void onCreate(Bundle b){super.onCreate(b);restoreKeepSession();getWindow().setStatusBarColor(Color.WHITE);getWindow().setNavigationBarColor(Color.rgb(242,242,247));getWindow().getDecorView().setSystemUiVisibility(android.view.View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR|android.view.View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR);web=new WebView(this);web.setWebChromeClient(new WebChromeClient());setContentView(web);web.getSettings().setUserAgentString(web.getSettings().getUserAgentString()+" SHOU-U-RUN/1.2.9 (com.runlab.app)");web.getSettings().setJavaScriptEnabled(true);web.getSettings().setDomStorageEnabled(true);web.getSettings().setAllowFileAccess(false);web.getSettings().setAllowContentAccess(false);web.getSettings().setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);web.addJavascriptInterface(new Bridge(),"Android");web.setWebViewClient(new WebViewClient(){
 @Override public WebResourceResponse shouldInterceptRequest(WebView v,WebResourceRequest r){Uri u=r.getUrl();if("app.runlab.local".equals(u.getHost())){String p=u.getPath();if(p==null||p.contains(".."))return new WebResourceResponse("text/plain","UTF-8",new ByteArrayInputStream(new byte[0]));if(p.equals("/"))p="/index.html";try{String mime=p.endsWith(".js")?"application/javascript":p.endsWith(".css")?"text/css":p.endsWith(".json")?"application/json":p.endsWith(".png")?"image/png":"text/html";return new WebResourceResponse(mime,"UTF-8",getAssets().open(p.substring(1)));}catch(Exception e){return new WebResourceResponse("text/plain","UTF-8",new ByteArrayInputStream(new byte[0]));}}return null;}
 @Override public void onReceivedHttpError(WebView v,WebResourceRequest r,WebResourceResponse e){reportMapError(r.getUrl(), "http", e.getStatusCode());}
 @Override public void onReceivedError(WebView v,WebResourceRequest r,WebResourceError e){reportMapError(r.getUrl(), "network", e.getErrorCode());}
 @Override public boolean shouldOverrideUrlLoading(WebView v,WebResourceRequest r){return !"app.runlab.local".equals(r.getUrl().getHost());}
 });web.loadUrl("https://app.runlab.local/index.html");}
 private void reportMapError(Uri url, String kind, int code) {
  if (!"tile.openstreetmap.org".equals(url.getHost()) && !"server.arcgisonline.com".equals(url.getHost())) return;
  js("window.onMapNetworkError && window.onMapNetworkError({url:" + JSONObject.quote(url.toString()) +
    ",kind:" + JSONObject.quote(kind) + ",code:" + code + "})");
 }
 private void js(String code){runOnUiThread(()->{if(!isFinishing()&&!isDestroyed())web.evaluateJavascript(code,null);});}
 private void recorderMessage(String msg){js("onRecorderMessage("+JSONObject.quote(msg)+")");}
 private void recorderCommand(String action){
  if(!action.equals("start")&&!action.equals("pause")&&!action.equals("resume")&&!action.equals("stop"))return;
  if(action.equals("start")||action.equals("resume")){
   if(checkSelfPermission(android.Manifest.permission.ACCESS_FINE_LOCATION)!=android.content.pm.PackageManager.PERMISSION_GRANTED){recorderPermissionAction=action;requestPermissions(new String[]{android.Manifest.permission.ACCESS_FINE_LOCATION,android.Manifest.permission.ACCESS_COARSE_LOCATION},71);return;}
   if(Build.VERSION.SDK_INT>=33&&checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS)!=android.content.pm.PackageManager.PERMISSION_GRANTED){recorderPermissionAction=action;requestPermissions(new String[]{android.Manifest.permission.POST_NOTIFICATIONS},72);return;}
  }
  launchRecorder(action);
 }
 private void launchRecorder(String action){try{
  if((action.equals("start")||action.equals("resume"))&&!((android.location.LocationManager)getSystemService(LOCATION_SERVICE)).isProviderEnabled(android.location.LocationManager.GPS_PROVIDER)){recorderMessage("请打开手机定位 / GPS，再点开始或继续");return;}
  if(!action.equals("start")&&!RunRecorderService.live){recorderMessage("当前没有正在采集的记录；中断的数据可从历史记录导出");return;}
  Intent intent=new Intent(this,RunRecorderService.class).setAction(action);if(action.equals("start"))startForegroundService(intent);else startService(intent);recorderMessage("操作已发送");
 }catch(Exception e){recorderMessage("无法启动采集："+e.getMessage());}}
 @Override public void onRequestPermissionsResult(int request,String[] permissions,int[] results){super.onRequestPermissionsResult(request,permissions,results);String action=recorderPermissionAction;recorderPermissionAction=null;if(action==null)return;
  if(request==71){if(checkSelfPermission(android.Manifest.permission.ACCESS_FINE_LOCATION)==android.content.pm.PackageManager.PERMISSION_GRANTED)recorderCommand(action);else recorderMessage("需要精确定位才能采集跑步轨迹。请在系统设置 → 应用权限中允许精确位置，再返回开始。");}
  else if(request==72){launchRecorder(action);if(checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS)!=android.content.pm.PackageManager.PERMISSION_GRANTED)recorderMessage("通知权限未开启，可在应用内结束采集；建议在系统设置中开启通知");}}
 private void beginRealExport(String name){pool.execute(()->{try{
  if(!name.matches("real_[0-9]+_[a-f0-9]+\\.jsonl"))throw new IOException("记录名称无效");
  JSONObject state=new JSONObject(RunRecorderService.snapshot(this));if(RunRecorderService.live&&name.equals(state.optString("file")))throw new IOException("请先结束这次采集，再导出完整记录");
  File file=new File(RunRecorderService.directory(this),name);if(!file.isFile()||file.length()>32000000)throw new IOException("文件不存在或超过 32 MB 导出限制");
  ByteArrayOutputStream out=new ByteArrayOutputStream();try(InputStream in=new FileInputStream(file)){byte[] buf=new byte[8192];int n;while((n=in.read(buf))!=-1)out.write(buf,0,n);}byte[] bytes=out.toByteArray();
  runOnUiThread(()->{if(pending!=null){recorderMessage("请先完成当前保存");return;}pending=bytes;realExport=true;Intent i=new Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("application/octet-stream").putExtra(Intent.EXTRA_TITLE,name);try{startActivityForResult(i,42);}catch(Exception e){pending=null;realExport=false;recorderMessage("无法打开保存窗口");}});
 }catch(Exception e){runOnUiThread(()->recorderMessage("导出失败："+e.getMessage()));}});}
 private final KeepHistory keepHistory = new KeepHistory(this);

 private void historyMessage(String kind, JSONObject value) {
  String json = value.toString();
  // Large histories exceed WebView's single-message IPC budget.
  for (int start = 0; start < json.length(); start += 64000) {
   int end = Math.min(json.length(), start + 64000);
   js("window.onAndroidKeepHistory(" + JSONObject.quote(kind) + "," +
    JSONObject.quote(json.substring(start, end)) + "," + (end == json.length()) + ")");
  }
 }

 private void runKeepHistory(String operation) {
  pool.execute(() -> {
   String kind = operation.equals("single") ? "single" : operation.equals("history") ? "history" : "batch";
   try {
    KeepSessionStore.Session session = keepSession;
    if (session == null) throw new IOException("请先在「导出与登录」登录 Keep。");
    KeepUploader.readTokenClaims(session.token);
    KeepHistory.Result progress = value -> historyMessage(kind, value);
    JSONObject result;
    switch (operation) {
     case "single": result = keepHistory.importRuns(session, true, progress); break;
     case "history": result = keepHistory.importRuns(session, false, progress); break;
     case "scan": result = keepHistory.scan(session, progress); break;
     default: result = keepHistory.convert(session, progress); break;
    }
    historyMessage(kind, result);
   } catch (InterruptedException ignored) {
    Thread.currentThread().interrupt();
   } catch (Exception error) {
    String message = error.getMessage();
    if ((error instanceof KeepUploader.HttpFailure && ((KeepUploader.HttpFailure)error).status == 401) ||
        "Keep 登录凭证已经过期".equals(message)) {
     keepSession = null;
     keepStore.clear();
     message = "Keep 登录已过期，请重新登录。";
     keepAuthResult("expired", false, message);
    }
    if (message == null || !(message.startsWith("Keep ") || message.startsWith("请先"))) {
     message = "Keep 操作未完成，请检查网络后重试。";
    }
    try { historyMessage(kind, KeepHistory.event("error").put("ok", false).put("message", message)); }
    catch (JSONException ignored) {}
   }
  });
 }

 private void keepAuthResult(String phase, boolean success, String message) {
  js("onKeepAuthResult(" + JSONObject.quote(phase) + "," + success + "," + JSONObject.quote(message) + ")");
 }

 private void restoreKeepSession() {
  keepStore = new KeepSessionStore(this);
  pool.execute(() -> {
   try {
    keepSession = keepStore.load();
   } catch (Exception e) {
    keepStore.clear();
   }
  });
 }

 private static String safeKeepAuthError(Exception error) {
  return error instanceof KeepAuth.Failure ? error.getMessage() : "无法完成 Keep 登录请求，请检查网络后重试";
 }

 public class Bridge {
  @JavascriptInterface public void installUpdate(String tag, String hash) {
   runOnUiThread(() -> appUpdate.install(tag, hash));
  }
 @JavascriptInterface public void sendKeepSms(String phone) {
  pool.execute(() -> {
   try {
    long now = SystemClock.elapsedRealtime();
    if (now < nextKeepSmsAt) throw new KeepAuth.Failure("请等待 60 秒后重发验证码");
    KeepAuth attempt = new KeepAuth(phone);
    nextKeepSmsAt = now + 60000;
    keepAuth = null;
    attempt.sendSms();
    keepAuth = attempt;
    keepAuthResult("sms", true, "验证码已发送，请查看短信");
   } catch (Exception e) {
    keepAuthResult("sms", false, safeKeepAuthError(e));
   }
  });
 }

 @JavascriptInterface public void verifyKeepSms(String phone, String code) {
  pool.execute(() -> {
   try {
    if (keepAuth == null || !keepAuth.phone.equals(phone)) {
     throw new KeepAuth.Failure("请先向该手机号发送验证码");
    }
    String token = keepAuth.verifySms(code);
    String phoneLabel = keepAuth.phone.substring(0, 3) + "****" + keepAuth.phone.substring(7);
    keepSession = new KeepSessionStore.Session(token, phoneLabel, keepAuth.deviceId);
    keepAuth = null;
    try {
     keepStore.save(keepSession);
     keepAuthResult("login", true, "Keep 登录成功，已加密保存到本机");
    } catch (Exception e) {
     keepStore.clear();
     keepAuthResult("login", true, "本次已登录，但未能保存凭证，重启后需重新登录");
    }
   } catch (Exception e) {
    keepAuthResult("login", false, safeKeepAuthError(e));
   }
  });
 }

 @JavascriptInterface public void reportKeepSession() {
  pool.execute(() -> keepAuthResult("restore", true, keepSession == null
    ? "登录后会在本机加密保存凭证" : "已恢复本机保存的 Keep 凭证"));
 }

 @JavascriptInterface public void saveKeepToken(String rawToken) {
  pool.execute(() -> {
   String token = KeepUploader.normalizeToken(rawToken);
   try {
    KeepUploader.readTokenClaims(token);
   } catch (IllegalArgumentException e) {
    keepAuthResult("manual", false, e.getMessage());
    return;
   }
   KeepSessionStore.Session session = new KeepSessionStore.Session(token, "手动凭证", null);
   try {
    keepStore.save(session);
    keepSession = session;
    keepAuth = null;
    keepAuthResult("manual", true, "已加密保存到本机，上传时由 Keep 验证凭证");
   } catch (Exception e) {
    keepStore.clear();
    keepAuthResult("manual", false, "无法在本机保存凭证");
   }
  });
 }

 @JavascriptInterface public String keepAuthState() {
  KeepSessionStore.Session session = keepSession;
  return session == null ? "" : session.accountLabel;
 }

 @JavascriptInterface public void logoutKeep() {
  pool.execute(() -> {
   if (!keepStore.clear()) {
    keepAuthResult("logout", false, "未能清除本机凭证，请重试退出");
    return;
   }
   keepSession = null;
   keepAuth = null;
   keepAuthResult("logout", true, "已退出 Keep，并清除本机凭证");
  });
 }

 @JavascriptInterface public void importKeepRun() { runKeepHistory("single"); }
 @JavascriptInterface public void importKeepHistory() { runKeepHistory("history"); }
 @JavascriptInterface public void scanKeepFiles() { runKeepHistory("scan"); }
 @JavascriptInterface public void convertKeepFiles() { runKeepHistory("convert"); }
 @JavascriptInterface public void uploadKeep(String activityJson, String fallbackToken) {
  pool.execute(() -> {
   KeepSessionStore.Session session = keepSession;
   try {
    String message = KeepUploader.upload(activityJson,
      session == null ? fallbackToken : session.token,
      session == null ? null : session.deviceId);
    js("onKeepUploadResult(true," + JSONObject.quote(message) + ")");
   } catch (Exception e) {
    String message = e.getMessage();
    if (session != null && ("Keep 登录凭证已经过期".equals(message) ||
        (message != null && message.startsWith("Keep 返回 HTTP 401")))) {
     keepSession = null;
     keepStore.clear();
     keepAuthResult("expired", false, "Keep 登录已过期，请重新登录");
    }
    if (message == null || !message.matches("^(Keep 登录凭证.*|轨迹.*|运动.*|Keep 返回 HTTP [0-9]{3}.*|Keep 拒绝了记录.*)$")) {
     message = "上传失败，请检查网络和登录凭证";
    }
    js("onKeepUploadResult(false," + JSONObject.quote(message) + ")");
   }
  });
 }
 @JavascriptInterface public void recordRun(String action){runOnUiThread(()->recorderCommand(action));}
 @JavascriptInterface public String recorderState(){return RunRecorderService.snapshot(MainActivity.this);}
 @JavascriptInterface public void fitRunPace() {
  pool.execute(() -> js("onRunPaceSamples(" + RunPaceSamples.collect(MainActivity.this) + ")"));
 }
 @JavascriptInterface public String realRunHistory(){return RunRecorderService.history(MainActivity.this);}
 @JavascriptInterface public void exportRealRun(String name){beginRealExport(name);}
 @JavascriptInterface public void openRecorderSettings(){runOnUiThread(()->startActivity(new Intent(android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS,Uri.parse("package:"+getPackageName()))));}

 @JavascriptInterface public void requestRoute(String coords,int id){pool.execute(()->{HttpURLConnection conn=null;try{JSONArray a=new JSONArray(coords);if(a.length()<2||a.length()>8)throw new Exception("选点数量无效");StringBuilder s=new StringBuilder();for(int i=0;i<a.length();i++){JSONArray p=a.getJSONArray(i);double lat=p.getDouble(0),lon=p.getDouble(1);if(!Double.isFinite(lat)||!Double.isFinite(lon)||Math.abs(lat)>85||Math.abs(lon)>180)throw new Exception("坐标无效");if(i>0)s.append(';');s.append(lon).append(',').append(lat);}URL url=new URL("https://routing.openstreetmap.de/routed-foot/route/v1/foot/"+s+"?overview=full&geometries=geojson");conn=(HttpURLConnection)url.openConnection();conn.setConnectTimeout(15000);conn.setReadTimeout(25000);conn.setRequestProperty("User-Agent","RunLab/0.3 Android Route Planner");if(conn.getResponseCode()!=200)throw new Exception("路线服务暂不可用");ByteArrayOutputStream out=new ByteArrayOutputStream();try(InputStream in=conn.getInputStream()){byte[] buf=new byte[8192];int n;while((n=in.read(buf))!=-1){out.write(buf,0,n);if(out.size()>8000000)throw new Exception("路线数据过大");}}js("onRouteResult("+id+","+JSONObject.quote(out.toString("UTF-8"))+",null)");}catch(Exception e){js("onRouteResult("+id+",null,"+JSONObject.quote("在线步行规划失败。上海离线底图仍可浏览；校园周边可离线规划。")+")");}finally{if(conn!=null)conn.disconnect();}});}
 @JavascriptInterface public void saveFile(String name,String base64,String mime){try{if(base64.length()>24000000)throw new Exception("文件过大");byte[] bytes=Base64.decode(base64,Base64.DEFAULT);runOnUiThread(()->{if(pending!=null){js("onSaveResult(false,'请先完成当前保存')");return;}pending=bytes;Intent i=new Intent(Intent.ACTION_CREATE_DOCUMENT);i.addCategory(Intent.CATEGORY_OPENABLE);i.setType(name.endsWith(".gpx")?"application/gpx+xml":"application/octet-stream");i.putExtra(Intent.EXTRA_TITLE,name.replaceAll("[^a-zA-Z0-9_.-]","_"));try{startActivityForResult(i,42);}catch(Exception e){pending=null;js("onSaveResult(false,'无法打开系统文件选择器')");}});}catch(Exception e){js("onSaveResult(false,'文件生成失败')");}}
 }
 @Override protected void onActivityResult(int request,int result,Intent data){super.onActivityResult(request,result,data);if(request==42){byte[] bytes=pending;pending=null;final boolean wasReal=realExport;realExport=false;if(result==RESULT_OK&&data!=null&&data.getData()!=null&&bytes!=null){final Uri uri=data.getData();pool.execute(()->{try(OutputStream o=getContentResolver().openOutputStream(uri)){if(o==null)throw new IOException();o.write(bytes);if(wasReal)recorderMessage("原始记录已导出");else js("onSaveResult(true,'文件已保存')");}catch(Exception e){if(wasReal)recorderMessage("保存失败，请重试");else js("onSaveResult(false,'保存失败，请重试')");}});}else {if(wasReal)recorderMessage("已取消导出，本机原始数据仍保留");else js("onSaveResult(true,'已取消保存，可以重新导出')");}}}
 @Override public void onBackPressed(){new AlertDialog.Builder(this).setMessage("退出页面？真实跑步采集会继续，请在通知或应用内结束。未导出的模拟设置不会保存。").setPositiveButton("退出",(d,w)->finish()).setNegativeButton("继续编辑",null).show();}
 @Override protected void onDestroy(){pool.shutdownNow();keepSession=null;web.removeJavascriptInterface("Android");web.destroy();super.onDestroy();}
}
