package cl.fleetchile.driver;
import org.junit.Test;
import static org.junit.Assert.*;
public class TrackingTimeTest {
    @Test public void timestampsRoundTripAcrossZonesAndFractionPrecision() throws Exception {
        long epoch=TrackingTime.parse("2026-10-31T12:00:00.123Z");
        assertEquals("2026-10-31T12:00:00.123Z",TrackingTime.iso(epoch));
        assertEquals(epoch,TrackingTime.parse("2026-10-31T09:00:00.123000-03:00"));
        assertEquals(epoch-123,TrackingTime.parse("2026-10-31T12:00:00Z"));
        assertEquals(epoch-23,TrackingTime.parse("2026-10-31T12:00:00.1Z"));
    }
    @Test public void invalidExpiryCannotSilentlyExtendSession() throws Exception {
        for(String value:new String[]{null,"","2026-02-31T12:00:00Z","2026-10-31T12:00:00","2026-10-31T12:00:00Zjunk"}) {
            try { TrackingTime.parse(value); fail("Invalid expiry accepted"); } catch(java.text.ParseException expected) { }
        }
    }
}
