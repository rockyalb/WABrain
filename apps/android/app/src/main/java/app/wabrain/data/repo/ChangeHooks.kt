package app.wabrain.data.repo

/** Side effects repositories trigger; implemented with WorkManager and Glance in the app, fakes in tests. */
interface ChangeHooks {
    /** Cached data changed: refresh widgets. */
    suspend fun localDataChanged()

    /** A mutation was queued: schedule an outbox flush. */
    fun outboxEnqueued()

    /**
     * A sync finished: [pendingReviewIds] are the Review items still pending. Notifications posted
     * before [syncStartedAt] for any other item are stale.
     */
    suspend fun reviewsSynced(pendingReviewIds: Set<String>, syncStartedAt: Long) = Unit

    object None : ChangeHooks {
        override suspend fun localDataChanged() = Unit
        override fun outboxEnqueued() = Unit
    }
}
