package app.wabrain.push

import app.wabrain.data.api.ReviewItemType
import org.junit.Assert.assertEquals
import org.junit.Test

class PushPayloadTest {
    @Test
    fun decodesEveryServerPayload() {
        assertEquals(PushPayload.Sync, PushPayload.parse("""{"type":"sync"}"""))
        assertEquals(
            PushPayload.Review("r1", ReviewItemType.POSSIBLY_DONE, "Contract"),
            PushPayload.parse("""{"type":"review","reviewItemId":"r1","reviewType":"possibly_done","title":"Contract"}"""),
        )
        assertEquals(
            PushPayload.Reminder("t1", "Send contract", "2026-09-24T15:00:00Z"),
            PushPayload.parse("""{"type":"reminder","taskId":"t1","title":"Send contract","dueAt":"2026-09-24T15:00:00Z"}"""),
        )
        assertEquals(
            PushPayload.Summary(4, 1, 2, 3),
            PushPayload.parse("""{"type":"summary","open":4,"dueToday":1,"overdue":2,"review":3}"""),
        )
    }

    @Test
    fun decodesTheDurableNotificationId() {
        val review = PushPayload.parse(
            """{"type":"review","notificationId":"n1","reviewItemId":"r1","reviewType":"create","title":"Contract"}""",
        )
        assertEquals(PushPayload.Review("r1", ReviewItemType.CREATE, "Contract", "n1"), review)
        assertEquals(
            PushPayload.Review("r2", ReviewItemType.CREATE, "Check the invoice", "n4", from = "Sam · Office"),
            PushPayload.parse(
                """{"type":"review","notificationId":"n4","reviewItemId":"r2","reviewType":"create","title":"Check the invoice","from":"Sam · Office"}""",
            ),
        )
        assertEquals("n1", review.notificationId)
        assertEquals(
            "n2",
            PushPayload.parse("""{"type":"reminder","notificationId":"n2","taskId":"t1","title":"T","dueAt":null}""").notificationId,
        )
        assertEquals("n3", PushPayload.parse("""{"type":"summary","notificationId":"n3","open":1}""").notificationId)
        assertEquals(null, PushPayload.parse("""{"type":"sync"}""").notificationId)
    }

    @Test
    fun malformedOrUnknownPayloadsStillRequestSync() {
        assertEquals(PushPayload.Unknown, PushPayload.parse("not JSON"))
        assertEquals(PushPayload.Unknown, PushPayload.parse("""{"type":"review","title":"No id"}"""))
        assertEquals(PushPayload.Unknown, PushPayload.parse("""{"type":"future"}"""))
    }
}
