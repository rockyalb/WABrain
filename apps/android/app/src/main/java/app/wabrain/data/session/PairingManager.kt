package app.wabrain.data.session

import android.content.Context
import android.os.Build
import androidx.core.app.NotificationManagerCompat
import app.wabrain.data.api.ApiClient
import app.wabrain.data.db.AppDatabase
import app.wabrain.data.repo.ChangeHooks
import app.wabrain.domain.PairingLink
import app.wabrain.push.PushController
import app.wabrain.sync.WorkScheduler
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/** Pairs the device with a server and undoes it. */
class PairingManager(
    private val context: Context,
    private val api: ApiClient,
    private val db: AppDatabase,
    private val session: SessionStore,
    private val hooks: ChangeHooks,
) {
    fun defaultDeviceName(): String {
        val manufacturer = Build.MANUFACTURER.replaceFirstChar { it.uppercase() }
        val model = Build.MODEL
        return (if (model.startsWith(manufacturer, ignoreCase = true)) model else "$manufacturer $model").take(80)
    }

    /** Exchanges the one-time pairing code for a device token and starts syncing. */
    suspend fun pair(link: PairingLink, deviceName: String) {
        val response = api.pair(link.server, link.code, deviceName.ifBlank { defaultDeviceName() }.take(80))
        withContext(Dispatchers.IO) { db.clearAllTables() }
        session.savePairing(link.server.toString(), response.deviceId, response.token, deviceName, System.currentTimeMillis())
        WorkScheduler.schedulePeriodicSync(context)
        WorkScheduler.syncNow(context)
    }

    /**
     * Unpairs: removes the push endpoint and revokes the token on the server
     * (best effort), then wipes local state. Returns false if the server could
     * not be reached; the local data is wiped either way.
     */
    suspend fun unpair(): Boolean {
        runCatching { api.deletePushEndpoint() }
        val serverOk = runCatching { api.unpairSelf() }.isSuccess
        resetLocal(revoked = false)
        return serverOk
    }

    /** Clears every local trace of the pairing. [revoked] means the server rejected our token. */
    suspend fun resetLocal(revoked: Boolean) {
        PushController.unregister(context)
        WorkScheduler.cancelAll(context)
        withContext(Dispatchers.IO) { db.clearAllTables() }
        session.clear(revoked)
        NotificationManagerCompat.from(context).cancelAll()
        hooks.localDataChanged()
    }
}
