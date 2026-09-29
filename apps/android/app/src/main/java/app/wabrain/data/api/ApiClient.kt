package app.wabrain.data.api

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.KSerializer
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException
import java.time.Duration
import java.time.Instant
import java.time.ZonedDateTime
import java.time.format.DateTimeFormatter
import java.util.UUID
import java.util.concurrent.TimeUnit

/** Shared JSON configuration. Decoding tolerates unknown keys and unknown enum values (falls back to defaults). */
val WabJson: Json = Json {
    ignoreUnknownKeys = true
    coerceInputValues = true
    encodeDefaults = true
    // Request DTOs omit null optionals: Zod `.optional()` rejects explicit nulls.
    explicitNulls = false
}

/** The server answered with a non-2xx status. */
class ApiException(
    val status: Int,
    val code: String?,
    message: String,
    /** The server's `Retry-After`, in seconds, when it sent one (429, 503). */
    val retryAfterSeconds: Long? = null,
) : IOException(message) {
    /** Retrying the same request later may succeed. */
    val isRetryable: Boolean get() = status == 408 || status == 425 || status == 429 || status >= 500
    val isUnauthorized: Boolean get() = status == 401
    val isNotImplemented: Boolean get() = status == 501
}

/**
 * Parses a `Retry-After` header, either delay-seconds or an HTTP date (RFC 9110).
 * Returns the seconds to wait (never negative), or null when the header is absent or invalid.
 */
fun parseRetryAfter(value: String?, now: Instant): Long? {
    val text = value?.trim().orEmpty()
    if (text.isEmpty()) return null
    text.toLongOrNull()?.let { return it.coerceAtLeast(0) }
    val at = runCatching { ZonedDateTime.parse(text, DateTimeFormatter.RFC_1123_DATE_TIME).toInstant() }.getOrNull() ?: return null
    return Duration.between(now, at).seconds.coerceAtLeast(0)
}

/** No device is paired yet, so there is no server or token to use. */
class NotPairedException : IOException("Device is not paired")

/** The server connection the client talks to. */
data class Credentials(val baseUrl: HttpUrl, val token: String)

/**
 * Thin, hand-written client for docs/API.md over OkHttp and kotlinx.serialization.
 * Every mutating call sends an Idempotency-Key; callers that retry (the outbox)
 * pass a stable key so the server replays the first response.
 */
class ApiClient(
    private val http: OkHttpClient,
    private val credentials: suspend () -> Credentials?,
) {
    // ---------------------------------------------------------------- pairing

    suspend fun pair(server: HttpUrl, code: String, deviceName: String): PairResponse {
        val body = WabJson.encodeToString(PairRequest.serializer(), PairRequest(code, deviceName))
        // Pairing is not idempotent on the server (single-use code), so no Idempotency-Key.
        val text = execute("POST", server, "v1/devices/pair", body = body, token = null, idempotencyKey = null)
        return WabJson.decodeFromString(PairResponse.serializer(), text)
    }

    suspend fun unpairSelf() {
        call("DELETE", path("v1", "devices", "self"), idempotencyKey = newKey())
    }

    // ---------------------------------------------------------------- sync

    suspend fun sync(since: String?): SyncResponse =
        get(path("v1", "sync"), SyncResponse.serializer(), query = mapOf("since" to since))

    // ---------------------------------------------------------------- tasks

    suspend fun listTasks(status: String, cursor: String? = null): PageDto<TaskDto> =
        get(path("v1", "tasks"), PageDto.serializer(TaskDto.serializer()), mapOf("status" to status, "cursor" to cursor))

    suspend fun taskDetail(id: String): TaskDetailResponse =
        get(path("v1", "tasks", id), TaskDetailResponse.serializer())

    suspend fun undoEvent(eventId: String): TaskDto =
        decode(call("POST", path("v1", "task-events", eventId, "undo"), body = "{}", idempotencyKey = newKey()), TaskDto.serializer())

    // ---------------------------------------------------------------- review / messages

    suspend fun messagesAround(chatId: String, messageId: String?, before: Int = 20, after: Int = 20): MessagesResponse =
        get(
            path("v1", "chats", chatId, "messages"),
            MessagesResponse.serializer(),
            mapOf("around" to messageId, "before" to before.toString(), "after" to after.toString()),
        )

    // ---------------------------------------------------------------- chats

    suspend fun patchChat(id: String, patch: JsonObject): ChatDto =
        decode(call("PATCH", path("v1", "chats", id), body = patch.toString(), idempotencyKey = newKey()), ChatDto.serializer())

    suspend fun deleteChatData(id: String) {
        call("DELETE", path("v1", "chats", id, "data"), idempotencyKey = newKey())
    }

    // ---------------------------------------------------------------- people

    suspend fun person(id: String): PersonDto = get(path("v1", "people", id), PersonDto.serializer())

    suspend fun patchPerson(id: String, patch: JsonObject) {
        call("PATCH", path("v1", "people", id), body = patch.toString(), idempotencyKey = newKey())
    }

    suspend fun addFact(personId: String, key: String, value: String) {
        val body = WabJson.encodeToString(AddFactRequest.serializer(), AddFactRequest(key, value))
        call("POST", path("v1", "people", personId, "facts"), body = body, idempotencyKey = newKey())
    }

    suspend fun patchFact(personId: String, factId: String, patch: JsonObject) {
        call("PATCH", path("v1", "people", personId, "facts", factId), body = patch.toString(), idempotencyKey = newKey())
    }

    /** Every stored source message of a fact, each with the chat it came from. */
    suspend fun factSources(personId: String, factId: String): MessagesResponse =
        get(path("v1", "people", personId, "facts", factId, "sources"), MessagesResponse.serializer())

    suspend fun deleteFact(personId: String, factId: String) {
        call("DELETE", path("v1", "people", personId, "facts", factId), idempotencyKey = newKey())
    }

    suspend fun deletePersonData(id: String) {
        call("DELETE", path("v1", "people", id, "data"), idempotencyKey = newKey())
    }

    // ---------------------------------------------------------------- contexts

    suspend fun createContext(name: String, color: String?): ContextDto {
        val body = WabJson.encodeToString(CreateContextRequest.serializer(), CreateContextRequest(name, color))
        return decode(call("POST", path("v1", "contexts"), body = body, idempotencyKey = newKey()), ContextDto.serializer())
    }

    suspend fun patchContext(id: String, patch: JsonObject): ContextDto =
        decode(call("PATCH", path("v1", "contexts", id), body = patch.toString(), idempotencyKey = newKey()), ContextDto.serializer())

    suspend fun deleteContext(id: String, reassignTo: String?) {
        call("DELETE", path("v1", "contexts", id), query = mapOf("reassignTo" to reassignTo), idempotencyKey = newKey())
    }

    // ---------------------------------------------------------------- settings

    suspend fun patchSettings(patch: JsonObject): SettingsDto =
        decode(call("PATCH", path("v1", "settings"), body = patch.toString(), idempotencyKey = newKey()), SettingsDto.serializer())

    // ---------------------------------------------------------------- push

    suspend fun registerPushEndpoint(request: PushEndpointRequest) {
        val body = WabJson.encodeToString(PushEndpointRequest.serializer(), request)
        call("POST", path("v1", "push-endpoints"), body = body, idempotencyKey = newKey())
    }

    suspend fun deletePushEndpoint() {
        call("DELETE", path("v1", "push-endpoints"), idempotencyKey = newKey())
    }

    /** This device's unacknowledged notifications (the fallback for missed pushes). */
    suspend fun notifications(): NotificationsResponse = get(path("v1", "notifications"), NotificationsResponse.serializer())

    suspend fun acknowledgeNotifications(ids: List<String>) {
        val body = WabJson.encodeToString(NotificationAckRequest.serializer(), NotificationAckRequest(ids))
        call("POST", path("v1", "notifications", "ack"), body = body, idempotencyKey = newKey())
    }

    // ---------------------------------------------------------------- ask

    suspend fun ask(request: AskRequestDto): AskResponseDto {
        val body = WabJson.encodeToString(AskRequestDto.serializer(), request)
        return decode(call("POST", path("v1", "ask"), body = body), AskResponseDto.serializer())
    }

    // ---------------------------------------------------------------- generic

    /**
     * Sends a stored request (used by the outbox). [encodedPath] is relative to
     * the server base URL and already percent-encoded, e.g. "v1/tasks/abc/complete".
     */
    suspend fun raw(method: String, encodedPath: String, body: String?, idempotencyKey: String): String =
        call(method, encodedPath, body = body, idempotencyKey = idempotencyKey)

    private suspend fun <T> get(encodedPath: String, serializer: KSerializer<T>, query: Map<String, String?> = emptyMap()): T =
        decode(call("GET", encodedPath, query = query), serializer)

    private fun <T> decode(text: String, serializer: KSerializer<T>): T = WabJson.decodeFromString(serializer, text)

    private suspend fun call(
        method: String,
        encodedPath: String,
        query: Map<String, String?> = emptyMap(),
        body: String? = null,
        idempotencyKey: String? = null,
    ): String {
        val creds = credentials() ?: throw NotPairedException()
        return execute(method, creds.baseUrl, encodedPath, query, body, creds.token, idempotencyKey)
    }

    private suspend fun execute(
        method: String,
        base: HttpUrl,
        encodedPath: String,
        query: Map<String, String?> = emptyMap(),
        body: String? = null,
        token: String?,
        idempotencyKey: String?,
    ): String = withContext(Dispatchers.IO) {
        val url = base.newBuilder().addEncodedPathSegments(encodedPath).apply {
            query.forEach { (k, v) -> if (v != null) addQueryParameter(k, v) }
        }.build()
        val requestBody = when {
            body != null -> body.toRequestBody(JSON_MEDIA)
            method == "POST" || method == "PATCH" || method == "PUT" -> "{}".toRequestBody(JSON_MEDIA)
            else -> null
        }
        val request = Request.Builder()
            .url(url)
            .method(method, requestBody)
            .header("Accept", "application/json")
            .apply {
                if (token != null) header("Authorization", "Bearer $token")
                if (idempotencyKey != null) header("Idempotency-Key", idempotencyKey)
            }
            .build()
        http.newCall(request).execute().use { response ->
            val text = response.body.string()
            if (!response.isSuccessful) {
                val error = runCatching { WabJson.decodeFromString(ErrorEnvelope.serializer(), text).error }.getOrNull()
                throw ApiException(
                    response.code,
                    error?.code,
                    error?.message ?: "HTTP ${response.code}",
                    parseRetryAfter(response.header("Retry-After"), Instant.now()),
                )
            }
            text.ifBlank { "{}" }
        }
    }

    companion object {
        private val JSON_MEDIA = "application/json; charset=utf-8".toMediaType()

        fun newKey(): String = UUID.randomUUID().toString()

        fun defaultHttpClient(): OkHttpClient = OkHttpClient.Builder()
            .connectTimeout(15, TimeUnit.SECONDS)
            .readTimeout(60, TimeUnit.SECONDS)
            .writeTimeout(30, TimeUnit.SECONDS)
            .build()

        private val PATH_BASE = "http://localhost/".toHttpUrl()

        /** Builds an encoded relative path from raw segments, e.g. path("v1", "tasks", id). */
        fun path(vararg segments: String): String {
            val builder = PATH_BASE.newBuilder()
            segments.forEach { builder.addPathSegment(it) }
            return builder.build().encodedPath.removePrefix("/")
        }
    }
}

