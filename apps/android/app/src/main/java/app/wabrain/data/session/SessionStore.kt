package app.wabrain.data.session

import android.content.Context
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.longPreferencesKey
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import app.wabrain.data.api.Credentials
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull

private val Context.sessionDataStore: DataStore<Preferences> by preferencesDataStore(name = "session")

/** What the app knows about its pairing with a server. */
data class Session(
    val serverUrl: String,
    val deviceId: String,
    val deviceName: String,
    val pairedAt: Long,
)

/** UnifiedPush registration state as last reported by the distributor. */
data class PushState(
    val endpoint: String?,
    val p256dh: String?,
    val auth: String?,
    val registeredWithServer: Boolean,
    val lastError: String?,
)

/**
 * Pairing and push state in DataStore. The device token is encrypted with a
 * Keystore key ([TokenCipher]) and only decrypted into memory when needed.
 */
class SessionStore(context: Context, private val cipher: TokenCipher) {
    private val store = context.sessionDataStore

    @Volatile
    private var cachedCredentials: Credentials? = null

    /** Set when the server rejected the token (device revoked); cleared on the next pairing. */
    val revoked: Flow<Boolean> = store.data.map { it[REVOKED] ?: false }

    val session: Flow<Session?> = store.data.map { prefs ->
        val server = prefs[SERVER_URL] ?: return@map null
        if (prefs[TOKEN_ENC] == null) return@map null
        Session(
            serverUrl = server,
            deviceId = prefs[DEVICE_ID].orEmpty(),
            deviceName = prefs[DEVICE_NAME].orEmpty(),
            pairedAt = prefs[PAIRED_AT] ?: 0L,
        )
    }

    val push: Flow<PushState> = store.data.map { prefs ->
        PushState(
            endpoint = prefs[PUSH_ENDPOINT],
            p256dh = prefs[PUSH_P256DH],
            auth = prefs[PUSH_AUTH],
            registeredWithServer = prefs[PUSH_REGISTERED] ?: false,
            lastError = prefs[PUSH_ERROR],
        )
    }

    suspend fun isPaired(): Boolean = session.first() != null

    suspend fun credentials(): Credentials? {
        cachedCredentials?.let { return it }
        val prefs = store.data.first()
        val url = prefs[SERVER_URL]?.toHttpUrlOrNull() ?: return null
        val token = prefs[TOKEN_ENC]?.let(cipher::decrypt) ?: return null
        return Credentials(url, token).also { cachedCredentials = it }
    }

    suspend fun savePairing(serverUrl: String, deviceId: String, token: String, deviceName: String, now: Long) {
        val encrypted = cipher.encrypt(token)
        store.edit {
            it.clear()
            it[SERVER_URL] = serverUrl
            it[DEVICE_ID] = deviceId
            it[TOKEN_ENC] = encrypted
            it[DEVICE_NAME] = deviceName
            it[PAIRED_AT] = now
        }
        cachedCredentials = null
    }

    suspend fun clear(revoked: Boolean = false) {
        store.edit {
            it.clear()
            if (revoked) it[REVOKED] = true
        }
        cachedCredentials = null
    }

    suspend fun savePushEndpoint(endpoint: String, p256dh: String?, auth: String?) {
        store.edit {
            val changed = it[PUSH_ENDPOINT] != endpoint || it[PUSH_P256DH] != p256dh || it[PUSH_AUTH] != auth
            it[PUSH_ENDPOINT] = endpoint
            if (p256dh != null) it[PUSH_P256DH] = p256dh else it.remove(PUSH_P256DH)
            if (auth != null) it[PUSH_AUTH] = auth else it.remove(PUSH_AUTH)
            if (changed) it[PUSH_REGISTERED] = false
            it.remove(PUSH_ERROR)
        }
    }

    suspend fun markPushRegistered(registered: Boolean) {
        store.edit { it[PUSH_REGISTERED] = registered }
    }

    suspend fun setPushError(error: String?) {
        store.edit { if (error == null) it.remove(PUSH_ERROR) else it[PUSH_ERROR] = error }
    }

    suspend fun clearPush() {
        store.edit {
            it.remove(PUSH_ENDPOINT)
            it.remove(PUSH_P256DH)
            it.remove(PUSH_AUTH)
            it.remove(PUSH_REGISTERED)
        }
    }

    suspend fun pushState(): PushState = push.first()

    suspend fun pushPrompted(): Boolean = store.data.first()[PUSH_PROMPTED] ?: false

    suspend fun markPushPrompted() {
        store.edit { it[PUSH_PROMPTED] = true }
    }

    private companion object {
        val SERVER_URL = stringPreferencesKey("server_url")
        val DEVICE_ID = stringPreferencesKey("device_id")
        val DEVICE_NAME = stringPreferencesKey("device_name")
        val TOKEN_ENC = stringPreferencesKey("token_enc")
        val PAIRED_AT = longPreferencesKey("paired_at")
        val REVOKED = booleanPreferencesKey("revoked")
        val PUSH_ENDPOINT = stringPreferencesKey("push_endpoint")
        val PUSH_P256DH = stringPreferencesKey("push_p256dh")
        val PUSH_AUTH = stringPreferencesKey("push_auth")
        val PUSH_REGISTERED = booleanPreferencesKey("push_registered")
        val PUSH_ERROR = stringPreferencesKey("push_error")
        val PUSH_PROMPTED = booleanPreferencesKey("push_prompted")
    }
}
