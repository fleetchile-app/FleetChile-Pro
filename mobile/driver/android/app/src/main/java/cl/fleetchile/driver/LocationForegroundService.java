package cl.fleetchile.driver;

import android.app.*;
import android.content.*;
import android.content.pm.ServiceInfo;
import android.location.*;
import android.os.*;
import com.getcapacitor.JSObject;
import org.json.*;
import java.io.*;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.UUID;
import java.util.concurrent.*;
import javax.net.ssl.HttpsURLConnection;

/** Location and HTTPS processing never depend on a WebView timer or JS callback. */
public class LocationForegroundService extends Service implements LocationListener {
    private static final Object LOCK = new Object();
    private static volatile LocationForegroundService instance;
    private static String preparedTrip, preparedToken;
    private static volatile String reason = "stopped";
    private static final String HOST = "https://fleetchile-pro.onrender.com";
    private static final String STOP = "cl.fleetchile.driver.STOP_TRACKING";
    private final ScheduledExecutorService worker = Executors.newSingleThreadScheduledExecutor();
    private volatile boolean running;
    private TrackingStore store;
    private LocationManager locations;
    private PowerManager.WakeLock wake;
    private String trip, token;
    private volatile JSONObject scope;
    private volatile JSONObject liveContext;
    private boolean started;
    private int failures;
    private volatile String state = "starting";
    private volatile long lastFix;
    private long nextSend;
    private volatile int sampleSeconds=30;
    private volatile long sessionStarted, sessionExpires;
    private long observedFixElapsed, collectedElapsed;

    static void prepare(Context context, String tripId, String bearer) throws Exception {
        synchronized (LOCK) {
            if (instance != null || preparedToken != null) throw new IllegalStateException("Tracking already started; stop before switching actor");
            // Expire old credentials after process death; old points remain review-only.
            TrackingStore storage = new TrackingStore(context); JSONObject data = storage.read();
            TrackingStore.archive(data); storage.write(data);
            preparedTrip=tripId; preparedToken=bearer; reason="starting";
        }
    }
    static boolean idle() { synchronized(LOCK) { return instance==null && preparedToken==null; } }
    static void clearPrepared() { synchronized(LOCK) { preparedTrip=null; preparedToken=null; } }
    static void requestStop(Context context, String why) {
        synchronized (LOCK) {
            clearPrepared(); reason=why;
            if (instance != null) instance.running=false;
            try { TrackingStore storage=new TrackingStore(context); JSONObject data=storage.read(); TrackingStore.archive(data); storage.write(data); }
            catch (Exception ignored) { /* Never log tokens or positions. An unreadable store fails closed on next start. */ }
            if (instance != null) {
                LocationForegroundService service=instance;
                new Handler(Looper.getMainLooper()).post(service::finishStop);
            }
        }
    }
    static JSObject snapshot(Context context) {
        JSObject result=new JSObject(); LocationForegroundService current=instance;
        if(current!=null && !current.running) current=null;
        result.put("running", (current != null && current.running) || preparedToken != null);
        result.put("state", current != null && current.running ? current.state : preparedToken != null ? "starting" : "stopped");
        result.put("reason", reason);
        result.put("signal", current != null && current.lastFix > 0 && System.currentTimeMillis()-current.lastFix < 120000 ? "gps" : "waiting");
        result.put("tripId", current == null ? null : current.trip);
        result.put("context", current == null ? null : current.liveContext);
        result.put("expiresAt", current == null || current.scope == null ? null : current.scope.optString("expires_at",null));
        result.put("lastFixAt", current == null || current.lastFix == 0 ? null : TrackingTime.iso(current.lastFix));
        synchronized(LOCK) {
            try { TrackingStore storage=new TrackingStore(context); JSONObject data=storage.read(); TrackingStore.prune(data,System.currentTimeMillis());
                result.put("pending",data.optJSONArray("points").length()); result.put("reviewPending",data.optJSONArray("review").length()); }
            catch(Exception ignored) { result.put("storageError",true); }
        }
        return result;
    }
    @Override public void onCreate() { super.onCreate(); store=new TrackingStore(this); locations=(LocationManager)getSystemService(LOCATION_SERVICE); }
    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && STOP.equals(intent.getAction())) { requestStop(this,"notification_stop"); stopSelf(); return START_NOT_STICKY; }
        synchronized(LOCK) {
            if (running) return START_NOT_STICKY;
            if (preparedToken == null) { stopSelf(); return START_NOT_STICKY; }
            trip=preparedTrip; token=preparedToken; clearPrepared(); instance=this; running=true;
        }
        try {
            NotificationManager manager=(NotificationManager)getSystemService(NOTIFICATION_SERVICE);
            if (Build.VERSION.SDK_INT >= 26) manager.createNotificationChannel(new NotificationChannel("fleet_location","GPS del conductor",NotificationManager.IMPORTANCE_LOW));
            Notification notification=notification();
            if (Build.VERSION.SDK_INT>=29) startForeground(501,notification,ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION); else startForeground(501,notification);
            // Keep native sampling/upload scheduled during screen-off, bounded by service lifetime.
            wake=((PowerManager)getSystemService(POWER_SERVICE)).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK,"FleetChile:Tracking");
            wake.acquire(10*60*1000L);
            worker.scheduleWithFixedDelay(this::tick,0,5,TimeUnit.SECONDS);
        } catch (Exception e) { requestStop(this,"foreground_start_failed"); }
        return START_NOT_STICKY;
    }
    private Notification notification() {
        PendingIntent stop=PendingIntent.getService(this,1,new Intent(this,LocationForegroundService.class).setAction(STOP),PendingIntent.FLAG_IMMUTABLE|PendingIntent.FLAG_UPDATE_CURRENT);
        PendingIntent open=PendingIntent.getActivity(this,2,new Intent(this,MainActivity.class),PendingIntent.FLAG_IMMUTABLE|PendingIntent.FLAG_UPDATE_CURRENT);
        String text="Ubicación activa durante la salida. Puedes detenerla aquí.";
        if(scope!=null && scope.has("expires_at")) {
            try { text="Sesión hasta "+java.text.DateFormat.getTimeInstance(java.text.DateFormat.SHORT).format(new java.util.Date(TrackingTime.parse(scope.getString("expires_at"))))+". Puedes detener el GPS aquí."; }
            catch(Exception ignored) { }
        }
        Notification.Builder builder=Build.VERSION.SDK_INT>=26 ? new Notification.Builder(this,"fleet_location") : new Notification.Builder(this);
        return builder.setSmallIcon(android.R.drawable.ic_menu_mylocation).setContentTitle("FleetChile · GPS activo")
            .setContentText(text).setContentIntent(open).setOngoing(true).setOnlyAlertOnce(true).setCategory(Notification.CATEGORY_SERVICE)
            .addAction(new Notification.Action.Builder(null,"Detener",stop).build()).build();
    }
    private JSONObject http(String method, String suffix, JSONObject body) throws Exception {
        if (!running || !TrackingPolicy.validTrip(trip) || !(suffix.equals("") || suffix.equals("/context") || suffix.equals("/positions"))) throw new IOException("Stopped or disallowed path");
        HttpsURLConnection connection=(HttpsURLConnection)new URL(HOST+"/api/driver/trips/"+trip+"/tracking"+suffix+(suffix.equals("/context") && scope!=null ? "?tracking_session_id="+scope.getString("tracking_session_id") : "")).openConnection();
        connection.setInstanceFollowRedirects(false); connection.setConnectTimeout(15000); connection.setReadTimeout(20000);
        connection.setRequestMethod(method); connection.setRequestProperty("Authorization","Bearer "+token);
        connection.setRequestProperty("Accept","application/json");
        try {
            if (body != null) { connection.setDoOutput(true); connection.setRequestProperty("Content-Type","application/json");
                byte[] bytes=body.toString().getBytes(StandardCharsets.UTF_8); connection.setFixedLengthStreamingMode(bytes.length);
                try(OutputStream out=connection.getOutputStream()) { out.write(bytes); } }
            int status=connection.getResponseCode();
            if (status<200 || status>=300) {
                String code="";
                try { code=readJson(connection.getErrorStream()).optString("code",""); } catch(Exception ignored) { }
                if (TrackingPolicy.terminalHttp(status,code,suffix.equals("/positions"))) requestStop(this,"http_"+status);
                throw new HttpFailure(status,code,suffix);
            }
            return readJson(connection.getInputStream());
        } finally { connection.disconnect(); }
    }
    private JSONObject readJson(InputStream stream) throws Exception {
        if(stream==null) throw new IOException("Empty tracking response");
        try(InputStream in=stream; ByteArrayOutputStream out=new ByteArrayOutputStream()) {
            byte[] buffer=new byte[4096]; int size;
            while((size=in.read(buffer))!=-1) { if(out.size()+size>262144) throw new IOException("Response too large"); out.write(buffer,0,size); }
            return new JSONObject(out.toString(StandardCharsets.UTF_8.name()));
        }
    }
    private JSONObject context(JSONObject response) throws Exception {
        // Contract response envelopes are normalized here only.
        try {
        JSONObject ctx=response.has("context") ? response.getJSONObject("context") : response;
        if(!UUID.fromString(ctx.getString("tracking_session_id")).toString().equalsIgnoreCase(ctx.getString("tracking_session_id"))) throw new ScopeException();
        if (!trip.equals(ctx.get("trip_id").toString())) throw new ScopeException();
        for (String name:new String[]{"user_id","company_id","driver_id","truck_id","resource_version","itinerary_version"})
            if (!ctx.has(name) || ctx.isNull(name)) throw new ScopeException();
        if(!ctx.has("outing_id") || !ctx.isNull("outing_id") && !TrackingPolicy.validTrip(ctx.get("outing_id").toString())) throw new ScopeException();
        long expires=TrackingTime.parse(ctx.getString("expires_at"));
        long began=TrackingTime.parse(ctx.getString("session_started_at"));
        if (expires<=System.currentTimeMillis() || began>=expires) throw new ScopeException();
        String current=ctx.getString("state");
        if (!TrackingPolicy.authorizedState(current) || ctx.optBoolean("review_required")) throw new ScopeException();
        if (scope!=null && !sameScope(scope,ctx)) {
            if(!TrackingPolicy.firstOutingBinding(sameBaseScope(scope,ctx),String.valueOf(scope.opt("outing_id")),String.valueOf(ctx.opt("outing_id")))) throw new ScopeException();
            synchronized(LOCK) {
                if(!running) throw new ScopeException();
                JSONObject data=store.read(); JSONArray points=data.getJSONArray("points");
                for(int i=0;i<points.length();i++) if(!points.getJSONObject(i).has("_scope_outing_id")) points.getJSONObject(i).put("_scope_outing_id",scope.opt("outing_id"));
                data.put("scope",ctx); store.write(data); scope=ctx;
            }
        }
        sessionStarted=began; sessionExpires=expires;
        int interval=TrackingPolicy.sampleSeconds(ctx.optInt("interval_seconds",30));
        if(started && interval!=sampleSeconds) new Handler(Looper.getMainLooper()).post(() -> { if(running) { locations.removeUpdates(this); subscribe(); } });
        sampleSeconds=interval;
        state=current; liveContext=ctx; return ctx;
        } catch (Exception invalid) { throw new ScopeException(); }
    }
    static boolean sameScope(JSONObject a, JSONObject b) {
        return sameBaseScope(a,b) && String.valueOf(a.opt("outing_id")).equals(String.valueOf(b.opt("outing_id")));
    }
    private static boolean sameBaseScope(JSONObject a, JSONObject b) {
        String[] keys={"tracking_session_id","trip_id","user_id","company_id","driver_id","truck_id","resource_version","itinerary_version","session_started_at","expires_at"};
        String[] left=new String[keys.length], right=new String[keys.length];
        for(int i=0;i<keys.length;i++) { left[i]=String.valueOf(a.opt(keys[i])); right[i]=String.valueOf(b.opt(keys[i])); }
        return TrackingPolicy.sameIdentity(left,right);
    }
    private void tick() {
        if (!running) return;
        JSONArray batch=new JSONArray();
        int pending=0;
        try {
            if (scope!=null && scope.has("expires_at") && TrackingTime.parse(scope.getString("expires_at"))<=System.currentTimeMillis()) throw new ScopeException();
            if (wake!=null) { if (wake.isHeld()) wake.release(); wake.acquire(10*60*1000L); }
            if (SystemClock.elapsedRealtime()<nextSend) return;
            if (!started) {
                scope=context(http("POST","",new JSONObject()));
                scope=context(http("GET","/context",null));
                synchronized(LOCK) { if (!running) return; JSONObject data=store.read(); data.put("token",token).put("scope",scope); store.write(data); }
                started=true;
                ((NotificationManager)getSystemService(NOTIFICATION_SERVICE)).notify(501,notification());
                new Handler(Looper.getMainLooper()).post(this::subscribe);
            }
            JSONObject live=context(http("GET","/context",null));
            synchronized(LOCK) {
                if (!running) return;
                JSONObject data=store.read(); TrackingStore.prune(data,System.currentTimeMillis()); store.write(data);
                JSONArray points=data.getJSONArray("points");
                pending=points.length();
                String[] phases=new String[points.length()];
                for(int i=0;i<phases.length;i++) phases[i]=points.getJSONObject(i).getString("state");
                for(int i:TrackingPolicy.batchIndices(phases,state)) {
                    JSONObject point=new JSONObject(points.getJSONObject(i).toString());
                    point.remove("stored_at"); point.remove("_scope_outing_id"); batch.put(point);
                }
            }
            if (batch.length()>0) {
                JSONObject payload=new JSONObject().put("tracking_session_id",scope.getString("tracking_session_id"))
                    .put("resource_version",scope.get("resource_version")).put("positions",batch);
                JSONObject ack=http("POST","/positions",payload);
                context(ack);
                JSONArray accepted=ack.getJSONArray("accepted_ids");
                synchronized(LOCK) {
                    if (!running) return;
                    JSONObject data=store.read(); JSONArray points=data.getJSONArray("points");
                    java.util.HashSet<String> ids=new java.util.HashSet<>();
                    for(int i=0;i<accepted.length();i++) ids.add(accepted.getString(i));
                    java.util.HashSet<String> sent=new java.util.HashSet<>();
                    for(int i=0;i<batch.length();i++) sent.add(batch.getJSONObject(i).getString("client_position_id"));
                    for(int i=points.length()-1;i>=0;i--) { String id=points.getJSONObject(i).getString("client_position_id"); if(ids.contains(id)&&sent.contains(id)) points.remove(i); }
                    pending=points.length();
                    store.write(data);
                }
            }
            failures=0; reason="tracking";
            nextSend=SystemClock.elapsedRealtime()+TrackingPolicy.sendDelay(pending,live.optInt("interval_seconds",30));
        } catch(ScopeException e) { requestStop(this,"context_closed_or_changed"); }
        catch(HttpFailure error) {
            if(running && error.path.equals("/positions") && batch.length()>0 && TrackingPolicy.quarantineBatch(error.status,error.code)) {
                try {
                    int remaining=archiveBatch(batch,error.code);
                    JSONObject live=context(http("GET","/context",null));
                    failures=0; reason="batch_review";
                    nextSend=SystemClock.elapsedRealtime()+TrackingPolicy.sendDelay(remaining,live.optInt("interval_seconds",30));
                } catch(ScopeException invalid) { requestStop(this,"context_closed_or_changed"); }
                catch(Exception failed) { retry(); }
            } else retry();
        }
        catch(Exception error) { retry(); }
    }
    private void retry() {
        if(!running) return;
        failures=Math.min(failures+1,7); reason="network_retry";
        nextSend=SystemClock.elapsedRealtime()+TrackingPolicy.retryDelay(failures)+java.util.concurrent.ThreadLocalRandom.current().nextLong(1000);
    }
    private int archiveBatch(JSONArray batch, String code) throws Exception {
        java.util.HashSet<String> rejected=new java.util.HashSet<>();
        for(int i=0;i<batch.length();i++) rejected.add(batch.getJSONObject(i).getString("client_position_id"));
        synchronized(LOCK) {
            if(!running) return 0;
            JSONObject data=store.read(); JSONArray points=data.getJSONArray("points"), review=data.getJSONArray("review"), remaining=new JSONArray();
            for(int i=0;i<points.length();i++) {
                JSONObject point=points.getJSONObject(i);
                if(rejected.contains(point.getString("client_position_id"))) {
                    review.put(new JSONObject().put("scope",TrackingStore.pointScope(data.getJSONObject("scope"),point)).put("point",point).put("reason",code));
                } else remaining.put(point);
            }
            data.put("points",remaining);
            store.write(data);
            return remaining.length();
        }
    }
    private void subscribe() {
        if (!running) return;
        try {
            boolean enabled=false;
            boolean fine=androidx.core.content.ContextCompat.checkSelfPermission(this,android.Manifest.permission.ACCESS_FINE_LOCATION)==android.content.pm.PackageManager.PERMISSION_GRANTED;
            for(String provider:new String[]{LocationManager.GPS_PROVIDER,LocationManager.NETWORK_PROVIDER}) {
                if (provider.equals(LocationManager.GPS_PROVIDER) && !fine) continue;
                if (locations.isProviderEnabled(provider)) { locations.requestLocationUpdates(provider,sampleSeconds*1000L,0f,this,Looper.getMainLooper()); enabled=true; }
            }
            if (!enabled) requestStop(this,"location_disabled");
        } catch(SecurityException e) { requestStop(this,"location_permission_revoked"); }
    }
    @Override public void onLocationChanged(Location location) {
        if (!running || scope==null) return;
        long now=System.currentTimeMillis(), elapsed=SystemClock.elapsedRealtimeNanos();
        if (!TrackingPolicy.withinSession(location.getTime(),sessionStarted,sessionExpires,now) || !TrackingPolicy.freshFix(location.getElapsedRealtimeNanos(),elapsed,observedFixElapsed,sampleSeconds)) return;
        if(!Double.isFinite(location.getLatitude()) || !Double.isFinite(location.getLongitude()) || Math.abs(location.getLatitude())>90 || Math.abs(location.getLongitude())>180 || !location.hasAccuracy() || !Float.isFinite(location.getAccuracy()) || location.getAccuracy()<0) return;
        observedFixElapsed=location.getElapsedRealtimeNanos(); lastFix=location.getTime();
        if(!TrackingPolicy.collect(elapsed,collectedElapsed,sampleSeconds)) return;
        collectedElapsed=elapsed;
        Location copy=new Location(location);
        String capturedState=state;
        Object capturedOuting=scope.opt("outing_id");
        worker.execute(() -> {
            if (!running) return;
            try {
                long storedNow=System.currentTimeMillis();
                if(!TrackingPolicy.withinSession(copy.getTime(),sessionStarted,sessionExpires,storedNow)) return;
                JSONObject point=new JSONObject().put("client_position_id",UUID.randomUUID().toString()).put("captured_at",TrackingTime.iso(copy.getTime()))
                    .put("state",capturedState).put("lat",copy.getLatitude()).put("lng",copy.getLongitude()).put("accuracy_m",copy.getAccuracy()).put("stored_at",copy.getTime()).put("_scope_outing_id",capturedOuting);
                if(copy.hasSpeed() && Float.isFinite(copy.getSpeed()) && copy.getSpeed()>=0) point.put("speed_kmh",copy.getSpeed()*3.6);
                synchronized(LOCK) { if(!running) return; JSONObject data=store.read(); data.getJSONArray("points").put(point); store.write(data); }
            } catch(Exception e) { requestStop(this,"storage_error"); }
        });
    }
    @Override public void onProviderDisabled(String provider) { if (running) reason="location_provider_disabled"; }
    @Override public void onProviderEnabled(String provider) { }
    @Override public void onStatusChanged(String provider,int status,Bundle extras) { }
    private void finishStop() { locations.removeUpdates(this); if(wake!=null && wake.isHeld()) wake.release(); stopForeground(STOP_FOREGROUND_REMOVE); stopSelf(); }
    @Override public void onDestroy() {
        synchronized(LOCK) { running=false; token=null; if(instance==this) instance=null; }
        locations.removeUpdates(this); worker.shutdownNow(); if(wake!=null && wake.isHeld()) wake.release(); super.onDestroy();
    }
    @Override public IBinder onBind(Intent intent) { return null; }
    private static class HttpFailure extends IOException {
        final int status; final String code, path;
        HttpFailure(int status,String code,String path) { super("Tracking HTTP failure"); this.status=status; this.code=code; this.path=path; }
    }
    private static class ScopeException extends Exception { }
}
