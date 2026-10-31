package cl.fleetchile.driver;
import javax.crypto.Cipher;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import java.util.Arrays;

/** The AndroidKeyStore owns the key; no key material is serialized. */
final class TrackingCrypto {
    static byte[] seal(byte[] plaintext, SecretKey key) throws Exception {
        Cipher cipher=Cipher.getInstance("AES/GCM/NoPadding"); cipher.init(Cipher.ENCRYPT_MODE,key);
        byte[] encrypted=cipher.doFinal(plaintext); byte[] nonce=cipher.getIV();
        byte[] result=Arrays.copyOf(nonce,nonce.length+encrypted.length);
        System.arraycopy(encrypted,0,result,nonce.length,encrypted.length); return result;
    }
    static byte[] open(byte[] envelope, SecretKey key) throws Exception {
        if(envelope.length<28) throw new java.io.IOException("Invalid encrypted store");
        Cipher cipher=Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE,key,new GCMParameterSpec(128,envelope,0,12));
        return cipher.doFinal(envelope,12,envelope.length-12);
    }
}
