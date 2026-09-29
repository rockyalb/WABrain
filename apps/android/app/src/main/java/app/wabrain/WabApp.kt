package app.wabrain

import android.app.Application
import android.content.Context
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.ProcessLifecycleOwner
import app.wabrain.notify.Notifier
import app.wabrain.push.PushController
import app.wabrain.sync.WorkScheduler
import kotlinx.coroutines.launch

class WabApp : Application() {
    lateinit var container: AppContainer
        private set

    override fun onCreate() {
        super.onCreate()
        container = AppContainer(this)
        Notifier.createChannels(this)

        // Sync trigger: every time the app comes to the foreground.
        ProcessLifecycleOwner.get().lifecycle.addObserver(
            object : DefaultLifecycleObserver {
                override fun onStart(owner: LifecycleOwner) {
                    container.appScope.launch {
                        if (container.session.isPaired()) {
                            WorkScheduler.syncNow(this@WabApp)
                            WorkScheduler.flushOutbox(this@WabApp)
                        }
                    }
                }
            },
        )

        container.appScope.launch {
            if (container.session.isPaired()) {
                WorkScheduler.schedulePeriodicSync(this@WabApp)
                // Recover if the process stopped after storing a distributor endpoint
                // but before its upload reached the server.
                val push = container.session.pushState()
                if (push.endpoint != null && !push.registeredWithServer) {
                    WorkScheduler.registerPushEndpoint(this@WabApp)
                }
                // UnifiedPush recommends re-registering at startup to refresh the endpoint.
                PushController.refreshRegistration(this@WabApp)
            }
        }
    }
}

val Context.appContainer: AppContainer get() = (applicationContext as WabApp).container
