package cl.fleetchile.driver;

import android.Manifest;
import android.app.AlertDialog;
import android.content.Intent;
import android.os.Build;
import androidx.core.content.ContextCompat;
import androidx.lifecycle.Lifecycle;
import com.getcapacitor.*;
import com.getcapacitor.annotation.*;

@CapacitorPlugin(name = "FleetTracking", permissions = {
    @Permission(alias = "location", strings = { Manifest.permission.ACCESS_COARSE_LOCATION, Manifest.permission.ACCESS_FINE_LOCATION }),
    @Permission(alias = "notifications", strings = { Manifest.permission.POST_NOTIFICATIONS })
})
public class FleetTrackingPlugin extends Plugin {
    private boolean starting;
    private int generation;
    private boolean visible() { return getActivity() != null && getActivity().getLifecycle().getCurrentState().isAtLeast(Lifecycle.State.RESUMED); }
    @PluginMethod public void start(PluginCall call) {
        String trip = call.getString("tripId");
        if (trip == null) { Object raw = call.getData().opt("tripId"); trip = raw == null ? null : raw.toString(); }
        String token = call.getString("token");
        if (trip == null || !trip.matches("[1-9][0-9]{0,18}") || token == null || token.trim().isEmpty() || token.length()>8192 || token.contains("\r") || token.contains("\n")) {
            call.reject("tripId/token inválidos"); return;
        }
        call.getData().put("tripId", trip);
        getActivity().runOnUiThread(() -> {
            if (!visible() || starting) { call.reject("Se requiere actividad visible y una sola solicitud"); return; }
            starting = true;
            call.getData().put("nativeGeneration", ++generation);
            new AlertDialog.Builder(getActivity()).setTitle("Compartir ubicación del viaje")
                .setMessage("FleetChile recopilará y enviará tu ubicación con la pantalla apagada o la app en segundo plano mientras la salida siga abierta. Puedes detenerla desde la notificación o cerrando sesión.")
                .setNegativeButton("Cancelar", (d,w) -> { starting=false; call.reject("Consentimiento cancelado"); })
                .setOnCancelListener(d -> { starting=false; call.reject("Consentimiento cancelado"); })
                .setPositiveButton("Activar GPS", (d,w) -> {
                    if (!visible() || !current(call)) { starting=false; call.reject("Inicio cancelado o actividad no visible"); return; }
                    requestPermissionForAlias("location", call, "locationResult");
                }).show();
        });
    }
    private boolean current(PluginCall call) { return call.getData().optInt("nativeGeneration",-1)==generation; }
    @PermissionCallback private void locationResult(PluginCall call) {
        if (!current(call)) { call.reject("Inicio cancelado"); return; }
        if (ContextCompat.checkSelfPermission(getContext(), Manifest.permission.ACCESS_COARSE_LOCATION) != android.content.pm.PackageManager.PERMISSION_GRANTED) {
            starting=false; call.reject("Permiso de ubicación denegado"); return;
        }
        if (Build.VERSION.SDK_INT >= 33 && getPermissionState("notifications") != PermissionState.GRANTED)
            requestPermissionForAlias("notifications", call, "notificationResult");
        else launch(call);
    }
    @PermissionCallback private void notificationResult(PluginCall call) { launch(call); }
    private void launch(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            starting=false;
            if (!visible() || !current(call)) { call.reject("Inicio cancelado o actividad no visible"); return; }
            try {
                // Credentials are handed directly in-process, never placed in Intent extras.
                LocationForegroundService.prepare(getContext(), call.getString("tripId"), call.getString("token"));
                ContextCompat.startForegroundService(getContext(), new Intent(getContext(), LocationForegroundService.class));
                call.resolve(LocationForegroundService.snapshot(getContext()));
            } catch (Exception e) { LocationForegroundService.clearPrepared(); call.reject("No se pudo iniciar GPS nativo"); }
        });
    }
    @PluginMethod public void stop(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            generation++; starting=false;
            LocationForegroundService.requestStop(getContext(), "explicit_stop");
            awaitStopped(call, 0);
        });
    }
    private void awaitStopped(PluginCall call, int attempt) {
        if (LocationForegroundService.idle()) { call.resolve(); return; }
        if (attempt>=100) { call.reject("GPS deteniéndose; reintentar status antes de iniciar"); return; }
        new android.os.Handler(android.os.Looper.getMainLooper()).postDelayed(() -> awaitStopped(call,attempt+1),20);
    }
    @PluginMethod public void status(PluginCall call) { call.resolve(LocationForegroundService.snapshot(getContext())); }
}
