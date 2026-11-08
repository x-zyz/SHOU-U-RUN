package com.runlab.app;
import android.app.*;
import android.content.*;
import android.content.pm.ServiceInfo;
import android.location.*;
import android.os.*;
import java.io.*;
import java.util.*;
import org.json.*;

public class RunRecorderService extends Service implements LocationListener {
 public static volatile boolean live=false;
 private LocationManager manager; private PowerManager.WakeLock wake;
 private BufferedWriter writer; private String file="",state="idle",message="";
 private int count=0; private long activeMs=0,anchor=0,lastFix=0; private float accuracy=-1;
 public static File directory(Context c){File d=new File(c.getFilesDir(),"real_runs");d.mkdirs();return d;}
 private static SharedPreferences prefs(Context c){return c.getSharedPreferences("real_recorder",0);}
 public static String snapshot(Context c){try{
  SharedPreferences p=prefs(c);String st=p.getString("state","idle");boolean alive=live;
  if(!alive&&(st.equals("recording")||st.equals("paused")))st="interrupted";
  long ms=p.getLong("activeMs",0);if(alive&&st.equals("recording"))ms+=Math.max(0,SystemClock.elapsedRealtime()-p.getLong("anchor",SystemClock.elapsedRealtime()));
  return new JSONObject().put("state",st).put("file",p.getString("file","")).put("count",p.getInt("count",0)).put("activeSeconds",ms/1000).put("accuracy",p.getFloat("accuracy",-1)).put("lastFixAge",p.getLong("lastFix",0)>0?Math.max(0,(SystemClock.elapsedRealtime()-p.getLong("lastFix",0))/1000):-1).put("message",st.equals("interrupted")?"上次采集被系统中断，已写入的原始点仍可导出":p.getString("message","")).toString();
 }catch(Exception e){return "{}";}}
 static File[] recordFiles(Context context) {
  File[] files = directory(context).listFiles((dir, name) -> name.matches("real_[0-9]+_[a-f0-9]+\\.jsonl"));
  if (files != null) Arrays.sort(files, (a, b) -> b.getName().compareTo(a.getName()));
  return files;
 }

 public static String history(Context context) {
  JSONArray history = new JSONArray();
  File[] files = recordFiles(context);
  if (files != null) for (File file : files) {
   try {
    history.put(new JSONObject().put("name", file.getName()).put("bytes", file.length()).put("modified", file.lastModified()));
   } catch (JSONException ignored) {}
  }
  return history.toString();
 }
 private void persist(){prefs(this).edit().putString("state",state).putString("file",file).putString("message",message).putInt("count",count).putLong("activeMs",activeMs).putLong("anchor",anchor).putLong("lastFix",lastFix).putFloat("accuracy",accuracy).apply();}
 private void append(JSONObject obj)throws Exception {writer.write(obj.toString());writer.newLine();writer.flush();}
 private JSONObject event(String type)throws Exception{return new JSONObject().put("type",type).put("received_time_ms",System.currentTimeMillis()).put("received_elapsed_ns",SystemClock.elapsedRealtimeNanos());}
 @Override public void onCreate(){super.onCreate();live=true;manager=(LocationManager)getSystemService(LOCATION_SERVICE);wake=((PowerManager)getSystemService(POWER_SERVICE)).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK,"SHOU:GPSRecording");wake.setReferenceCounted(false);((NotificationManager)getSystemService(NOTIFICATION_SERVICE)).createNotificationChannel(new NotificationChannel("real_runs","真实跑步采集",NotificationManager.IMPORTANCE_LOW));}
 private Notification notification(){PendingIntent open=PendingIntent.getActivity(this,1,new Intent(this,MainActivity.class),PendingIntent.FLAG_UPDATE_CURRENT|PendingIntent.FLAG_IMMUTABLE);PendingIntent stop=PendingIntent.getService(this,2,new Intent(this,RunRecorderService.class).setAction("stop"),PendingIntent.FLAG_UPDATE_CURRENT|PendingIntent.FLAG_IMMUTABLE);return new Notification.Builder(this,"real_runs").setSmallIcon(android.R.drawable.ic_menu_mylocation).setContentTitle(state.equals("paused")?"真实跑步 · 已暂停":"真实跑步 · 正在采集 GPS").setContentText("已保存 "+count+" 个原始点 · 点击返回应用").setContentIntent(open).setOngoing(true).addAction(new Notification.Action.Builder(null,"结束并保存",stop).build()).build();}
 private void notifyState(){((NotificationManager)getSystemService(NOTIFICATION_SERVICE)).notify(701,notification());}
 private void acquire()throws Exception{if(!manager.isProviderEnabled(LocationManager.GPS_PROVIDER))throw new Exception("请打开手机定位 / GPS 后重新开始");wake.acquire();manager.requestLocationUpdates(LocationManager.GPS_PROVIDER,1000,0,this,Looper.getMainLooper());anchor=SystemClock.elapsedRealtime();state="recording";message="等待 GPS 定位；请在室外采集";persist();}
 private void release(){try{manager.removeUpdates(this);}catch(Exception ignored){}if(wake.isHeld())wake.release();if(state.equals("recording"))activeMs+=Math.max(0,SystemClock.elapsedRealtime()-anchor);}
 private void finish(String endState,String msg){release();try{if(writer!=null)append(event(endState).put("sample_count",count).put("active_ms",activeMs).put("message",msg));}catch(Exception ignored){}try{if(writer!=null)writer.close();}catch(Exception ignored){}writer=null;state=endState;message=msg;persist();stopForeground(STOP_FOREGROUND_REMOVE);stopSelf();}
 @Override public int onStartCommand(Intent intent,int flags,int id){String action=intent==null?"":intent.getAction();try{
  if("start".equals(action)){
   if(writer!=null)return START_NOT_STICKY;
   state="recording";if(Build.VERSION.SDK_INT>=29)startForeground(701,notification(),ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION);else startForeground(701,notification());
   file="real_"+System.currentTimeMillis()+"_"+UUID.randomUUID().toString().replace("-","").substring(0,8)+".jsonl";
   writer=new BufferedWriter(new OutputStreamWriter(new FileOutputStream(new File(directory(this),file)),"UTF-8"));
   append(event("session").put("schema","shou.real-gps.v1").put("source","android_gps").put("synthetic",false).put("coordinate_system","WGS84").put("requested_interval_ms",1000).put("android_sdk",Build.VERSION.SDK_INT).put("device_model",Build.MODEL).put("heart_rate_available",false).put("cadence_available",false));acquire();
  }else if("pause".equals(action)&&writer!=null&&state.equals("recording")){release();state="paused";message="已暂停，不采集定位";append(event("pause"));persist();notifyState();
  }else if("resume".equals(action)&&writer!=null&&state.equals("paused")){acquire();append(event("resume"));notifyState();
  }else if("stop".equals(action)&&writer!=null){finish("completed","已结束并保存在本机");}
  else if(writer==null){stopSelf();}
 }catch(Exception e){finish("error","采集停止："+e.getMessage());}return START_NOT_STICKY;}
 @Override public void onLocationChanged(Location l){if(writer==null||!state.equals("recording"))return;try{
  JSONObject p=event("fix").put("time_ms",l.getTime()).put("elapsed_ns",l.getElapsedRealtimeNanos()).put("provider",l.getProvider()).put("lat",l.getLatitude()).put("lon",l.getLongitude()).put("mock",l.isFromMockProvider());
  p.put("accuracy_m",l.hasAccuracy()?l.getAccuracy():JSONObject.NULL).put("altitude_m",l.hasAltitude()?l.getAltitude():JSONObject.NULL).put("speed_mps",l.hasSpeed()?l.getSpeed():JSONObject.NULL).put("bearing_deg",l.hasBearing()?l.getBearing():JSONObject.NULL).put("vertical_accuracy_m",l.hasVerticalAccuracy()?l.getVerticalAccuracyMeters():JSONObject.NULL).put("speed_accuracy_mps",l.hasSpeedAccuracy()?l.getSpeedAccuracyMetersPerSecond():JSONObject.NULL).put("bearing_accuracy_deg",l.hasBearingAccuracy()?l.getBearingAccuracyDegrees():JSONObject.NULL);
  append(p);count++;lastFix=SystemClock.elapsedRealtime();accuracy=l.hasAccuracy()?l.getAccuracy():-1;message=l.isFromMockProvider()?"收到系统标记为模拟定位的点，已如实标注":"正在保存原始 GPS 点";persist();if(count%5==0)notifyState();
 }catch(Exception e){finish("error","写入失败，已停止采集："+e.getMessage());}}
 @Override public void onProviderDisabled(String provider){message="GPS 已关闭，等待恢复；不会补造定位点";try{if(writer!=null)append(event("gps_disabled"));}catch(Exception e){finish("error","写入失败");}persist();}
 @Override public void onProviderEnabled(String provider){message="GPS 已打开，等待定位";persist();}
 @Override public void onStatusChanged(String p,int status,Bundle b){}
 @Override public IBinder onBind(Intent i){return null;}
 @Override public void onDestroy(){if(writer!=null){release();try{append(event("interrupted"));writer.close();}catch(Exception ignored){}writer=null;state="interrupted";message="服务已停止，已采集数据仍保留";persist();}live=false;super.onDestroy();}
}
