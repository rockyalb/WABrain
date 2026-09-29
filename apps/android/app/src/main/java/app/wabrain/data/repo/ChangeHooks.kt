package app.wabrain.data.repo

/** Side effects repositories trigger; implemented with WorkManager and Glance in the app, fakes in tests. */
interface ChangeHooks {
    /** Cached data changed: refresh widgets. */
    suspend fun localDataChanged()

    /** A mutation was queued: schedule an outbox flush. */
    fun outboxEnqueued()

    object None : ChangeHooks {
        override suspend fun localDataChanged() = Unit
        override fun outboxEnqueued() = Unit
    }
}
