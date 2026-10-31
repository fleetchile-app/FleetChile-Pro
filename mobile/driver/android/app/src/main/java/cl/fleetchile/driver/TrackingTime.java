package cl.fleetchile.driver;
import java.text.SimpleDateFormat;
import java.text.ParsePosition;
import java.util.Date;
import java.util.Locale;
import java.util.TimeZone;

/** ISO timestamps without java.time, retaining Android API 24 compatibility. */
final class TrackingTime {
    static String iso(long millis) {
        SimpleDateFormat format=new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'",Locale.US);
        format.setTimeZone(TimeZone.getTimeZone("UTC")); return format.format(new Date(millis));
    }
    static long parse(String value) throws java.text.ParseException {
        if(value==null || !value.matches("[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]{1,9})?(Z|[+-][0-9]{2}:[0-9]{2})")) throw new java.text.ParseException("Invalid session expiry",0);
        String normalized=value;
        int dot=value.indexOf('.'); int zone=value.endsWith("Z") ? value.length()-1 : value.length()-6;
        if(dot<0) normalized=value.substring(0,zone)+".000"+value.substring(zone);
        else normalized=value.substring(0,dot+1)+(value.substring(dot+1,zone)+"000").substring(0,3)+value.substring(zone);
        SimpleDateFormat format=new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSSXXX",Locale.US); format.setLenient(false);
        ParsePosition cursor=new ParsePosition(0); Date parsed=format.parse(normalized,cursor);
        if(parsed==null || cursor.getIndex()!=normalized.length()) throw new java.text.ParseException("Invalid session expiry",0);
        return parsed.getTime();
    }
}
