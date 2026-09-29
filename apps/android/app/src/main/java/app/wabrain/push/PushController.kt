package app.wabrain.push

import android.app.Activity
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import org.unifiedpush.android.connector.UnifiedPush

/**
 * Wraps the UnifiedPush connector (v3). The connector generates the Web Push
 * key pair (p256dh/auth), stores it, and decrypts RFC 8291 (aes128gcm)
 * messages before they reach [WabPushService].
 */
object PushController {
    private const val MESSAGE_FOR_DISTRIBUTOR = "WABrain"

    /** Installed distributors (package names), excluding this app. */
    fun distributors(context: Context): List<String> =
        UnifiedPush.getDistributors(context).filter { it != context.packageName }

    /** The distributor that acknowledged our registration, if any. */
    fun currentDistributor(context: Context): String? = UnifiedPush.getAckDistributor(context)

    fun distributorLabel(context: Context, packageName: String): String = runCatching {
        val pm = context.packageManager
        val info = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            pm.getApplicationInfo(packageName, PackageManager.ApplicationInfoFlags.of(0))
        } else {
            @Suppress("DEPRECATION")
            pm.getApplicationInfo(packageName, 0)
        }
        pm.getApplicationLabel(info).toString()
    }.getOrDefault(packageName)

    /**
     * Uses the saved or system-default distributor (showing the system picker
     * when there are several) and registers. [onResult] gets false when no
     * distributor is available: the 15-minute sync keeps working.
     */
    fun registerWithDefault(activity: Activity, onResult: (Boolean) -> Unit) {
        if (distributors(activity).isEmpty()) {
            onResult(false)
            return
        }
        UnifiedPush.tryUseCurrentOrDefaultDistributor(activity) { success ->
            if (success) UnifiedPush.register(activity, messageForDistributor = MESSAGE_FOR_DISTRIBUTOR)
            onResult(success)
        }
    }

    /** Registers with an explicitly chosen distributor. */
    fun registerWith(context: Context, distributor: String) {
        UnifiedPush.saveDistributor(context, distributor)
        UnifiedPush.register(context, messageForDistributor = MESSAGE_FOR_DISTRIBUTOR)
    }

    /** Re-registers with the acknowledged distributor, if any (refreshes the endpoint). */
    fun refreshRegistration(context: Context) {
        if (currentDistributor(context) != null) {
            runCatching { UnifiedPush.register(context, messageForDistributor = MESSAGE_FOR_DISTRIBUTOR) }
        }
    }

    fun unregister(context: Context) {
        runCatching { UnifiedPush.unregister(context) }
    }
}
