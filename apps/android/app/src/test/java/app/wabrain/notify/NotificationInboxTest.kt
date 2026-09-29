package app.wabrain.notify

import app.wabrain.data.api.ApiException
import app.wabrain.data.api.NotificationEventDto
import app.wabrain.data.api.ReviewItemType
import app.wabrain.data.api.WabJson
import app.wabrain.push.PushPayload
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class NotificationInboxTest {
    private class MemoryStore(var saved: List<String> = emptyList()) : HandledIdStore {
        override fun load(): List<String> = saved
        override fun save(ids: List<String>) {
            saved = ids
        }
    }

    /** The server's list for one device: acknowledged ids disappear, like GET/POST /v1/notifications. */
    private class FakeFeed(items: List<NotificationEventDto>) : NotificationFeed {
        val items = items.toMutableList()
        val acknowledged = mutableListOf<List<String>>()
        var failAck = false
        var failList: Exception? = null

        override suspend fun pending(): List<NotificationEventDto> {
            failList?.let { throw it }
            return items.toList()
        }

        override suspend fun acknowledge(ids: List<String>) {
            if (failAck) throw ApiException(503, "unavailable", "down")
            acknowledged += ids
            items.removeAll { it.id in ids }
        }
    }

    private val shown = mutableListOf<PushPayload>()
    private val store = MemoryStore()
    private val inbox = NotificationInbox(NotificationLedger(store)) { shown += it; true }

    private fun event(id: String, json: String) =
        NotificationEventDto(id, "2026-09-24T09:00:00.000Z", WabJson.parseToJsonElement(json).jsonObject)

    private val review = event(
        "n1",
        """{"type":"review","notificationId":"n1","reviewItemId":"r1","reviewType":"possibly_done","title":"Kontrata"}""",
    )
    private val reminder = event(
        "n2",
        """{"type":"reminder","notificationId":"n2","taskId":"t1","title":"Fatura","dueAt":"2026-09-24T15:00:00.000Z"}""",
    )
    private val summary = event("n3", """{"type":"summary","open":4,"dueToday":1,"overdue":2,"review":3}""")

    @Test
    fun aPushedNotificationIsNotShownAgainByTheFallback() = runTest {
        val pushed = PushPayload.parse(
            """{"type":"review","notificationId":"n1","reviewItemId":"r1","reviewType":"possibly_done","title":"Kontrata"}""",
        )
        assertTrue(inbox.handle(pushed))
        // The same push delivered twice (distributor retry) is shown once.
        assertFalse(inbox.handle(pushed))

        val feed = FakeFeed(listOf(review, reminder))
        assertEquals(1, NotificationReconciler(feed, inbox).reconcile())
        assertEquals(
            listOf(
                PushPayload.Review("r1", ReviewItemType.POSSIBLY_DONE, "Kontrata", "n1"),
                PushPayload.Reminder("t1", "Fatura", "2026-09-24T15:00:00.000Z", "n2"),
            ),
            shown,
        )
        // Both are acknowledged, including the one the push already showed.
        assertEquals(listOf(listOf("n1", "n2")), feed.acknowledged)
        assertTrue(feed.items.isEmpty())
    }

    @Test
    fun theFallbackShowsMissedNotificationsOnceEvenWhenAcknowledgingFails() = runTest {
        val feed = FakeFeed(listOf(review, reminder, summary))
        feed.failAck = true
        val reconciler = NotificationReconciler(feed, inbox)
        try {
            reconciler.reconcile()
            fail("expected the acknowledgement failure to propagate for a retry")
        } catch (_: ApiException) {
        }
        assertEquals(3, shown.size)
        // The summary had no notificationId in its payload: the list item's id is used.
        assertEquals("n3", shown[2].notificationId)

        // The retry sees the same list; nothing is shown twice, and this time it is acknowledged.
        feed.failAck = false
        assertEquals(0, reconciler.reconcile())
        assertEquals(3, shown.size)
        assertEquals(listOf(listOf("n1", "n2", "n3")), feed.acknowledged)

        // A later push of an id recovered by the fallback is not shown either.
        assertFalse(inbox.handle(PushPayload.Summary(4, 1, 2, 3, "n3")))
    }

    @Test
    fun blockedNotificationsRemainPendingUntilTheyCanBeShown() = runTest {
        var allowed = false
        val ledger = NotificationLedger(store)
        val retryInbox = NotificationInbox(ledger) {
            if (allowed) shown += it
            allowed
        }
        val feed = FakeFeed(listOf(review))
        val reconciler = NotificationReconciler(feed, retryInbox)
        assertEquals(0, reconciler.reconcile())
        assertFalse(ledger.isHandled("n1"))
        assertTrue(feed.acknowledged.isEmpty())
        assertEquals(1, feed.items.size)

        allowed = true
        assertEquals(1, reconciler.reconcile())
        assertEquals(1, shown.size)
        assertTrue(ledger.isHandled("n1"))
        assertEquals(listOf(listOf("n1")), feed.acknowledged)
        assertEquals(0, reconciler.reconcile())
    }

    @Test
    fun aDisplayExceptionDoesNotConsumeTheNotification() {
        var failing = true
        val ledger = NotificationLedger(store)
        val retryInbox = NotificationInbox(ledger) {
            if (failing) throw IllegalStateException("display failed")
            true
        }
        val payload = PushPayload.Reminder("t1", "Fatura", null, "n2")
        try {
            retryInbox.handle(payload)
            fail("expected display failure")
        } catch (_: IllegalStateException) {
        }
        assertFalse(ledger.isHandled("n2"))
        failing = false
        assertTrue(retryInbox.handle(payload))
        assertFalse(retryInbox.handle(payload))
    }

    @Test
    fun handledIdsSurviveARestartAndStayBounded() {
        assertTrue(inbox.handle(PushPayload.Reminder("t1", "Fatura", null, "n2")))
        val restarted = NotificationInbox(NotificationLedger(MemoryStore(store.saved))) { shown += it; true }
        assertFalse(restarted.handle(PushPayload.Reminder("t1", "Fatura", null, "n2")))

        val small = NotificationLedger(MemoryStore(), capacity = 3)
        listOf("a", "b", "c", "d").forEach { assertTrue(small.markHandled(it)) }
        assertFalse(small.isHandled("a"))
        assertTrue(small.isHandled("d"))
    }

    @Test
    fun syncHintsUnknownPayloadsAndPayloadsWithoutAnIdAreNotDeduplicated() = runTest {
        assertFalse(inbox.handle(PushPayload.Sync))
        assertFalse(inbox.handle(PushPayload.Unknown))
        // An older server sends no notificationId: every push is shown.
        val legacy = PushPayload.parse("""{"type":"review","reviewItemId":"r9","reviewType":"create","title":"Old"}""")
        assertTrue(inbox.handle(legacy))
        assertTrue(inbox.handle(legacy))
        assertEquals(2, shown.size)

        // An unknown listed type is acknowledged but not shown.
        val feed = FakeFeed(listOf(event("n9", """{"type":"future","notificationId":"n9"}""")))
        assertEquals(0, NotificationReconciler(feed, inbox).reconcile())
        assertEquals(listOf(listOf("n9")), feed.acknowledged)
    }

    @Test
    fun anEmptyListAcknowledgesNothingAndServerErrorsPropagate() = runTest {
        val feed = FakeFeed(emptyList())
        assertEquals(0, NotificationReconciler(feed, inbox).reconcile())
        assertTrue(feed.acknowledged.isEmpty())

        feed.failList = ApiException(401, "unauthorized", "revoked")
        try {
            NotificationReconciler(feed, inbox).reconcile()
            fail("expected 401 to propagate so the worker unpairs")
        } catch (e: ApiException) {
            assertTrue(e.isUnauthorized)
        }
    }
}
