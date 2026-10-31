package cl.fleetchile.driver;
import org.junit.Test;
import static org.junit.Assert.*;
public class TrackingPolicyTest {
    @Test public void waitingAndReturningContinueUntilClosed() {
        for(String state:new String[]{"active","waiting","returning"}) assertTrue(TrackingPolicy.authorizedState(state));
        for(String state:new String[]{"closed","unknown","",null}) assertFalse(TrackingPolicy.authorizedState(state));
    }
    @Test public void rejectsRevokedIdentityWithoutRetrying() {
        for(int code:new int[]{401,403,409}) assertTrue(TrackingPolicy.terminalHttp(code,"",true));
        for(int code:new int[]{200,429,500,503}) assertFalse(TrackingPolicy.terminalHttp(code,"",true));
    }
    @Test public void phaseReviewOnlyQuarantinesExplicitPositionBatch() {
        assertTrue(TrackingPolicy.quarantineBatch(409,"POSITION_PHASE_REVIEW"));
        assertFalse(TrackingPolicy.terminalHttp(409,"POSITION_PHASE_REVIEW",true));
        assertTrue(TrackingPolicy.terminalHttp(409,"POSITION_PHASE_REVIEW",false));
        for(String code:new String[]{"RESOURCE_CHANGED","POSITION_ID_CONFLICT","TRACKING_CLOSED",""}) assertTrue(TrackingPolicy.terminalHttp(409,code,true));
        for(String code:new String[]{"INVALID_POSITION","INVALID_CAPTURE_TIME","INVALID_PHASE","INVALID_BATCH"}) assertTrue(TrackingPolicy.quarantineBatch(400,code));
        assertFalse(TrackingPolicy.quarantineBatch(400,"UNKNOWN"));
        assertFalse(TrackingPolicy.quarantineBatch(503,"INVALID_POSITION"));
    }
    @Test public void captureUsesConfiguredMonotonicIntervalAndRejectsProviderDuplicates() {
        long second=1000000000L;
        assertFalse(TrackingPolicy.collect(59*second,30*second,30));
        assertTrue(TrackingPolicy.collect(60*second,30*second,30));
        assertFalse(TrackingPolicy.freshFix(30*second,60*second,30*second,30));
        assertFalse(TrackingPolicy.freshFix(1,200*second,0,30));
        assertTrue(TrackingPolicy.freshFix(60*second,61*second,30*second,30));
        assertEquals(15,TrackingPolicy.sampleSeconds(0)); assertEquals(300,TrackingPolicy.sampleSeconds(999));
    }
    @Test public void fixesMustBelongToSessionBeforeEnqueue() {
        assertFalse(TrackingPolicy.withinSession(999,1000,5000,2000));
        assertTrue(TrackingPolicy.withinSession(1000,1000,5000,2000));
        assertFalse(TrackingPolicy.withinSession(5000,1000,5000,6000));
        assertFalse(TrackingPolicy.withinSession(3000,1000,5000,2000));
    }
    @Test public void tripCannotInjectHostPathOrQuery() {
        assertTrue(TrackingPolicy.validTrip("123"));
        for(String id:new String[]{"0","-1","1/context","1?host=x","https://other","../1",null}) assertFalse(TrackingPolicy.validTrip(id));
    }
    @Test public void retentionIs24HoursAndRejectsFutureClockData() {
        assertFalse(TrackingPolicy.expired(1000,86401000));
        assertTrue(TrackingPolicy.expired(1000,86401001));
        assertTrue(TrackingPolicy.expired(62000,1000));
    }
    @Test public void retriesAreExponentialAndBounded() {
        assertEquals(10000,TrackingPolicy.retryDelay(1));
        assertEquals(20000,TrackingPolicy.retryDelay(2));
        assertEquals(300000,TrackingPolicy.retryDelay(99));
    }
    @Test public void pendingPositionsCannotCrossAnyIdentityBoundary() {
        String[] original={"session","trip","user","company","driver","truck","resource","itinerary","outing"};
        assertTrue(TrackingPolicy.sameIdentity(original,original.clone()));
        for(int i=0;i<original.length;i++) { String[] changed=original.clone(); changed[i]="other"; assertFalse(TrackingPolicy.sameIdentity(original,changed)); }
    }
    @Test public void onlyFirstOutingCanBeBoundUnderSameAuthenticatedIdentity() {
        assertTrue(TrackingPolicy.firstOutingBinding(true,"null","123"));
        assertTrue(TrackingPolicy.firstOutingBinding(true,null,"123"));
        assertFalse(TrackingPolicy.firstOutingBinding(false,"null","123"));
        for(String id:new String[]{"0","-1","null","1/other",null}) assertFalse(TrackingPolicy.firstOutingBinding(true,"null",id));
        assertFalse(TrackingPolicy.firstOutingBinding(true,"123","456"));
        assertFalse(TrackingPolicy.firstOutingBinding(true,"123","null"));
    }
    @Test public void initialOutingBindingCannotBypassDifferentContextUserId() {
        String[] current={"uuid","trip","user_id:11","company","driver","truck","resource","itinerary","began","expires"};
        String[] anotherUser=current.clone(); anotherUser[2]="user_id:12";
        assertFalse(TrackingPolicy.firstOutingBinding(TrackingPolicy.sameIdentity(current,anotherUser),"null","123"));
        assertTrue(TrackingPolicy.firstOutingBinding(TrackingPolicy.sameIdentity(current,current.clone()),"null","123"));
    }
    @Test public void reconnectSendsLatestCurrentPhaseThenOldBackfillWithoutDuplicates() {
        String[] phases=new String[5000]; java.util.Arrays.fill(phases,"active");
        int[] chosen=TrackingPolicy.batchIndices(phases,"active");
        assertEquals(50,chosen.length); assertEquals(4999,chosen[0]);
        for(int i=1;i<50;i++) assertEquals(i-1,chosen[i]);
        java.util.HashSet<Integer> unique=new java.util.HashSet<>(); for(int i:chosen) assertTrue(unique.add(i));
        assertEquals(5000,TrackingPolicy.sendDelay(4950,30));
        assertEquals(30000,TrackingPolicy.sendDelay(50,30));
        assertFalse(TrackingPolicy.collect(35_000_000_000L,30_000_000_000L,30));
    }
    @Test public void prioritySelectionNeverMixesCapturePhasesOrDuplicatesLastPoint() {
        String[] phases={"active","waiting","active","returning","waiting","returning"};
        assertArrayEquals(new int[]{4,1},TrackingPolicy.batchIndices(phases,"waiting"));
        assertArrayEquals(new int[]{5,3},TrackingPolicy.batchIndices(phases,"returning"));
        assertArrayEquals(new int[]{2,0},TrackingPolicy.batchIndices(phases,"missing"));
        assertArrayEquals(new int[]{0},TrackingPolicy.batchIndices(new String[]{"active"},"active"));
        assertArrayEquals(new int[0],TrackingPolicy.batchIndices(new String[0],"active"));
    }
}
