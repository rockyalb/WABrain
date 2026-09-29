package app.wabrain.data.db

import androidx.room.Dao
import androidx.room.Query
import androidx.room.Upsert
import kotlinx.coroutines.flow.Flow

@Dao
interface TaskDao {
    @Query("SELECT * FROM tasks WHERE status = 'open'")
    fun observeOpen(): Flow<List<TaskEntity>>

    @Query("SELECT * FROM tasks WHERE status = 'open'")
    suspend fun openTasks(): List<TaskEntity>

    @Query("SELECT * FROM tasks")
    fun observeAll(): Flow<List<TaskEntity>>

    @Query("SELECT * FROM tasks WHERE id = :id")
    fun observe(id: String): Flow<TaskEntity?>

    @Query("SELECT * FROM tasks WHERE id = :id")
    suspend fun get(id: String): TaskEntity?

    @Query("SELECT * FROM tasks")
    suspend fun all(): List<TaskEntity>

    @Upsert
    suspend fun upsert(tasks: List<TaskEntity>)

    @Upsert
    suspend fun upsert(task: TaskEntity)

    @Query("DELETE FROM tasks WHERE id IN (:ids)")
    suspend fun delete(ids: List<String>)

    @Query("DELETE FROM tasks WHERE id NOT IN (:keep)")
    suspend fun deleteAllExcept(keep: List<String>)
}

@Dao
interface ReviewDao {
    @Query("SELECT * FROM review_items ORDER BY createdAt DESC")
    fun observeAll(): Flow<List<ReviewItemEntity>>

    @Query("SELECT COUNT(*) FROM review_items")
    fun observeCount(): Flow<Int>

    @Query("SELECT * FROM review_items WHERE id = :id")
    suspend fun get(id: String): ReviewItemEntity?

    @Query("SELECT * FROM review_items")
    suspend fun all(): List<ReviewItemEntity>

    @Upsert
    suspend fun upsert(items: List<ReviewItemEntity>)

    @Query("DELETE FROM review_items WHERE id IN (:ids)")
    suspend fun delete(ids: List<String>)

    @Query("DELETE FROM review_items")
    suspend fun deleteAll()
}

@Dao
interface ContextDao {
    @Query("SELECT * FROM contexts ORDER BY sortOrder, name")
    fun observeAll(): Flow<List<ContextEntity>>

    @Query("SELECT * FROM contexts ORDER BY sortOrder, name")
    suspend fun all(): List<ContextEntity>

    @Upsert
    suspend fun upsert(items: List<ContextEntity>)

    @Query("DELETE FROM contexts WHERE id IN (:ids)")
    suspend fun delete(ids: List<String>)

    @Query("DELETE FROM contexts")
    suspend fun deleteAll()
}

@Dao
interface ChatDao {
    @Query("SELECT * FROM chats ORDER BY lastMessageAt IS NULL, lastMessageAt DESC, name")
    fun observeAll(): Flow<List<ChatEntity>>

    @Query("SELECT * FROM chats")
    suspend fun all(): List<ChatEntity>

    @Query("SELECT * FROM chats WHERE id = :id")
    fun observe(id: String): Flow<ChatEntity?>

    @Upsert
    suspend fun upsert(items: List<ChatEntity>)

    @Query("DELETE FROM chats WHERE id IN (:ids)")
    suspend fun delete(ids: List<String>)

    @Query("DELETE FROM chats")
    suspend fun deleteAll()
}

@Dao
interface PersonDao {
    @Query("SELECT * FROM people ORDER BY displayName COLLATE NOCASE")
    fun observeAll(): Flow<List<PersonEntity>>

    @Query("SELECT * FROM people WHERE id = :id")
    fun observe(id: String): Flow<PersonEntity?>

    @Query("SELECT * FROM people")
    suspend fun all(): List<PersonEntity>

    @Upsert
    suspend fun upsert(items: List<PersonEntity>)

    @Query("DELETE FROM people WHERE id IN (:ids)")
    suspend fun delete(ids: List<String>)

    @Query("DELETE FROM people")
    suspend fun deleteAll()
}

@Dao
interface SettingsDao {
    @Query("SELECT * FROM settings WHERE id = 0")
    fun observe(): Flow<SettingsEntity?>

    @Query("SELECT * FROM settings WHERE id = 0")
    suspend fun get(): SettingsEntity?

    @Upsert
    suspend fun upsert(entity: SettingsEntity)
}

@Dao
interface MetaDao {
    @Query("SELECT value FROM meta WHERE `key` = :key")
    suspend fun get(key: String): String?

    @Upsert
    suspend fun put(entity: MetaEntity)

    @Query("DELETE FROM meta WHERE `key` = :key")
    suspend fun remove(key: String)
}

@Dao
interface OutboxDao {
    @Query("SELECT * FROM outbox ORDER BY seq LIMIT 1")
    suspend fun first(): OutboxEntity?

    @Query("SELECT * FROM outbox ORDER BY seq")
    suspend fun all(): List<OutboxEntity>

    @Query("SELECT COUNT(*) FROM outbox")
    fun observeCount(): Flow<Int>

    @Upsert
    suspend fun insert(entity: OutboxEntity): Long

    @Query("DELETE FROM outbox WHERE seq = :seq")
    suspend fun delete(seq: Long)

    @Query("UPDATE outbox SET attempts = attempts + 1, lastError = :error WHERE seq = :seq")
    suspend fun markFailed(seq: Long, error: String?)

    /** Task ids with unsent mutations; sync must not overwrite these rows. */
    @Query(
        "SELECT entityId FROM outbox WHERE entityType = 'task' " +
            "UNION SELECT relatedTaskId FROM outbox WHERE relatedTaskId IS NOT NULL",
    )
    suspend fun pendingTaskIds(): List<String>

    @Query("SELECT entityId FROM outbox WHERE entityType = 'review'")
    suspend fun pendingReviewIds(): List<String>

    @Query("SELECT COUNT(*) FROM outbox WHERE entityType = :type AND entityId = :id")
    suspend fun countFor(type: String, id: String): Int
}
