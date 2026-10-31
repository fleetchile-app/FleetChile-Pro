package cl.fleetchile.driver;
import android.os.Bundle;
import com.getcapacitor.BridgeActivity;
public class MainActivity extends BridgeActivity {
    @Override public void onCreate(Bundle savedInstanceState) {
        registerPlugin(FleetTrackingPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
