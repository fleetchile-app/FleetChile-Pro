package cl.fleetchile.driver;
import org.junit.Test;
import static org.junit.Assert.*;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
public class TrackingCryptoTest {
    private SecretKey key() throws Exception { KeyGenerator generator=KeyGenerator.getInstance("AES"); generator.init(256); return generator.generateKey(); }
    @Test public void credentialsAndCoordinatesRoundTripOnlyWithKey() throws Exception {
        SecretKey key=key(); byte[] original="token=synthetic;lat=-33;scope=driver-1".getBytes(StandardCharsets.UTF_8);
        byte[] encrypted=TrackingCrypto.seal(original,key);
        assertArrayEquals(original,TrackingCrypto.open(encrypted,key));
        assertFalse(new String(encrypted,StandardCharsets.UTF_8).contains("synthetic"));
        assertFalse(Arrays.equals(encrypted,TrackingCrypto.seal(original,key)));
    }
    @Test public void tamperingOrDifferentActorKeyCannotDecrypt() throws Exception {
        SecretKey key=key(); byte[] encrypted=TrackingCrypto.seal(new byte[]{1,2,3},key);
        try { TrackingCrypto.open(encrypted,key()); fail("Wrong key accepted"); } catch(javax.crypto.AEADBadTagException expected) { }
        encrypted[encrypted.length-1]^=1;
        try { TrackingCrypto.open(encrypted,key); fail("Tampered data accepted"); } catch(javax.crypto.AEADBadTagException expected) { }
    }
    @Test public void truncatedCiphertextFailsClosed() throws Exception {
        try { TrackingCrypto.open(new byte[12],key()); fail("Truncation accepted"); } catch(java.io.IOException expected) { }
    }
}
