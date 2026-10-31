package cl.fleetchile.driver;

import android.content.Context;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.AtomicFile;
import org.json.JSONArray;
import org.json.JSONObject;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import java.io.*;
import java.security.KeyStore;

/** All credentials, scopes and positions are stored only in an AES-GCM private file. */
final class TrackingStore {
    private final AtomicFile file;
    TrackingStore(Context context) { file = new AtomicFile(new File(context.getNoBackupFilesDir(), "fleet-tracking.enc")); }
    private SecretKey key() throws Exception {
        KeyStore ks = KeyStore.getInstance("AndroidKeyStore"); ks.load(null);
        if (!ks.containsAlias("FleetTracking.v1")) {
            KeyGenerator gen = KeyGenerator.getInstance("AES", "AndroidKeyStore");
            gen.init(new KeyGenParameterSpec.Builder("FleetTracking.v1", KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setKeySize(256).setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build());
            gen.generateKey();
        }
        return (SecretKey) ks.getKey("FleetTracking.v1", null);
    }
    synchronized JSONObject read() throws Exception {
        if (!file.getBaseFile().exists() && !new File(file.getBaseFile().getPath()+".bak").exists()) return new JSONObject().put("points", new JSONArray()).put("review", new JSONArray());
        byte[] data = file.readFully();
        return new JSONObject(new String(TrackingCrypto.open(data,key()), java.nio.charset.StandardCharsets.UTF_8));
    }
    synchronized void write(JSONObject data) throws Exception {
        prune(data, System.currentTimeMillis());
        byte[] encrypted = TrackingCrypto.seal(data.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8),key());
        FileOutputStream out = null;
        try { out = file.startWrite(); out.write(encrypted); file.finishWrite(out); }
        catch (Exception e) { if (out != null) file.failWrite(out); throw e; }
    }
    static void prune(JSONObject data, long now) throws Exception {
        JSONArray review = data.optJSONArray("review"); if (review == null) review = new JSONArray();
        JSONArray points = data.optJSONArray("points"); if (points == null) points = new JSONArray();
        int count = 0;
        for (int i = points.length()-1; i >= 0; i--) {
            if (TrackingPolicy.expired(points.getJSONObject(i).getLong("stored_at"), now) || ++count > 10000) points.remove(i);
        }
        for (int i = review.length()-1; i >= 0; i--) {
            JSONObject entry = review.getJSONObject(i);
            if (TrackingPolicy.expired(entry.getJSONObject("point").getLong("stored_at"), now) || ++count > 10000) review.remove(i);
        }
        data.put("points", points).put("review", review);
    }
    static void archive(JSONObject data) throws Exception {
        JSONArray review = data.optJSONArray("review"); if (review == null) review = new JSONArray();
        JSONArray points = data.optJSONArray("points");
        if (points != null) for (int i=0; i<points.length(); i++) review.put(new JSONObject().put("scope", pointScope(data.optJSONObject("scope"),points.getJSONObject(i))).put("point", points.getJSONObject(i)));
        data.put("review", review).put("points", new JSONArray()); data.remove("token"); data.remove("scope");
    }
    static JSONObject pointScope(JSONObject scope, JSONObject point) throws Exception {
        JSONObject snapshot=new JSONObject();
        if(scope!=null) for(String key:new String[]{"tracking_session_id","trip_id","user_id","company_id","driver_id","truck_id","resource_version","itinerary_version","outing_id","session_started_at","expires_at"}) snapshot.put(key,scope.opt(key));
        if(point.has("_scope_outing_id")) snapshot.put("outing_id",point.opt("_scope_outing_id"));
        return snapshot;
    }
}
