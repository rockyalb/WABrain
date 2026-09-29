package app.wabrain.push

import app.wabrain.data.api.ReviewItemType
import app.wabrain.data.api.WabJson
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/**
 * Decrypted UnifiedPush / Web Push payloads (docs/API.md "Push"). The same
 * shapes come from `GET /v1/notifications`. [notificationId] is the server's
 * durable event id: each id is shown at most once, whichever way it arrived.
 */
sealed class PushPayload {
    open val notificationId: String? get() = null

    data object Sync : PushPayload()

    data class Review(
        val reviewItemId: String,
        val reviewType: ReviewItemType,
        val title: String,
        override val notificationId: String? = null,
        /** Who it came from ("Sam", "Sam · Office"); null when the server does not say. */
        val from: String? = null,
    ) : PushPayload()

    data class Reminder(
        val taskId: String,
        val title: String,
        val dueAt: String?,
        override val notificationId: String? = null,
    ) : PushPayload()

    data class Summary(
        val open: Int,
        val dueToday: Int,
        val overdue: Int,
        val review: Int,
        override val notificationId: String? = null,
    ) : PushPayload()

    /** Unknown or malformed payload: the app still syncs. */
    data object Unknown : PushPayload()

    companion object {
        fun parse(bytes: ByteArray): PushPayload = parse(bytes.toString(Charsets.UTF_8))

        fun parse(text: String): PushPayload {
            val obj = runCatching { WabJson.parseToJsonElement(text).jsonObject }.getOrNull() ?: return Unknown
            return parse(obj)
        }

        /** [fallbackId] is used when the object carries no `notificationId` (the list item's id). */
        fun parse(obj: JsonObject, fallbackId: String? = null): PushPayload {
            val notificationId = obj.string("notificationId") ?: fallbackId
            return when (obj.string("type")) {
                "sync" -> Sync
                "review" -> {
                    val id = obj.string("reviewItemId") ?: return Unknown
                    Review(
                        id,
                        ReviewItemType.fromWire(obj.string("reviewType")),
                        obj.string("title").orEmpty(),
                        notificationId,
                        obj.string("from")?.takeIf { it.isNotBlank() },
                    )
                }
                "reminder" -> {
                    val id = obj.string("taskId") ?: return Unknown
                    Reminder(id, obj.string("title").orEmpty(), obj.string("dueAt"), notificationId)
                }
                "summary" -> Summary(
                    open = obj.int("open"),
                    dueToday = obj.int("dueToday"),
                    overdue = obj.int("overdue"),
                    review = obj.int("review"),
                    notificationId = notificationId,
                )
                else -> Unknown
            }
        }

        private fun JsonObject.string(key: String): String? =
            runCatching { this[key]?.jsonPrimitive?.contentOrNull }.getOrNull()

        private fun JsonObject.int(key: String): Int =
            runCatching { this[key]?.jsonPrimitive?.intOrNull }.getOrNull() ?: 0
    }
}
