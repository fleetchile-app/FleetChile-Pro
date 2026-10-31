package cl.fleetchile.driver;

/** Pure policies shared by the service and local JVM tests. */
final class TrackingPolicy {
    static boolean authorizedState(String state) {
        return "active".equals(state) || "waiting".equals(state) || "returning".equals(state);
    }
    static boolean quarantineBatch(int status, String code) {
        return status==409 && "POSITION_PHASE_REVIEW".equals(code) || status==400 &&
            ("INVALID_POSITION".equals(code)||"INVALID_CAPTURE_TIME".equals(code)||"INVALID_PHASE".equals(code)||"INVALID_BATCH".equals(code));
    }
    static boolean terminalHttp(int status, String code, boolean positions) {
        return status==401 || status==403 || status==404 || status==409 && !(positions && quarantineBatch(status,code));
    }
    static int sampleSeconds(int seconds) { return Math.max(15,Math.min(300,seconds)); }
    static boolean collect(long elapsed, long previous, int seconds) { return previous==0 || elapsed-previous>=sampleSeconds(seconds)*1000000000L; }
    static boolean freshFix(long fixElapsed, long nowElapsed, long observed, int seconds) {
        return fixElapsed>observed && fixElapsed>0 && fixElapsed<=nowElapsed && nowElapsed-fixElapsed<=Math.max(60000L,sampleSeconds(seconds)*2000L)*1000000L;
    }
    static boolean withinSession(long captured, long started, long expires, long now) { return captured>=started && captured<expires && captured<=now && now-captured<=86400000L; }
    static boolean validTrip(String trip) { return trip != null && trip.matches("[1-9][0-9]{0,18}"); }
    static boolean expired(long storedAt, long now) { return now-storedAt>86400000L || storedAt>now+60000; }
    static long retryDelay(int failures) { return Math.min(300000,5000L*(1L<<Math.min(Math.max(failures,0),7))); }
    static boolean sameIdentity(String[] a, String[] b) { return java.util.Arrays.equals(a,b); }
    static boolean firstOutingBinding(boolean sameBaseScope, String before, String after) {
        return sameBaseScope && (before==null || "null".equals(before)) && validTrip(after);
    }
    static int[] batchIndices(String[] phases, String current) {
        if(phases.length==0) return new int[0];
        String phase=phases[0];
        for(String candidate:phases) if(current.equals(candidate)) { phase=current; break; }
        int latest=phases.length-1;
        while(!phase.equals(phases[latest])) latest--;
        int[] chosen=new int[Math.min(50,phases.length)]; int count=0;
        chosen[count++]=latest;
        for(int i=0;i<phases.length && count<50;i++) if(i!=latest && phase.equals(phases[i])) chosen[count++]=i;
        return java.util.Arrays.copyOf(chosen,count);
    }
    static long sendDelay(int pending, int interval) { return pending>50 ? 5000L : sampleSeconds(interval)*1000L; }
}
