package app.wabrain.data.db

import android.content.Context
import androidx.room.Database
import androidx.room.Room
import androidx.room.RoomDatabase
import androidx.room.migration.Migration
import androidx.sqlite.db.SupportSQLiteDatabase

@Database(
    entities = [
        TaskEntity::class,
        ReviewItemEntity::class,
        ContextEntity::class,
        ChatEntity::class,
        PersonEntity::class,
        SettingsEntity::class,
        MetaEntity::class,
        OutboxEntity::class,
    ],
    version = 5,
    exportSchema = true,
)
abstract class AppDatabase : RoomDatabase() {
    abstract fun tasks(): TaskDao
    abstract fun reviews(): ReviewDao
    abstract fun contexts(): ContextDao
    abstract fun chats(): ChatDao
    abstract fun people(): PersonDao
    abstract fun settings(): SettingsDao
    abstract fun meta(): MetaDao
    abstract fun outbox(): OutboxDao

    companion object {
        val MIGRATION_3_4 = object : Migration(3, 4) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL("ALTER TABLE tasks ADD COLUMN closedBy TEXT")
                // Re-fetch existing closures with their actor, retaining queued offline changes.
                db.execSQL("DELETE FROM meta WHERE `key` = 'sync_cursor'")
            }
        }

        val MIGRATION_4_5 = object : Migration(4, 5) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL("ALTER TABLE tasks ADD COLUMN createdBy TEXT")
                // Re-fetch tasks with their creator, retaining queued offline changes.
                db.execSQL("DELETE FROM meta WHERE `key` = 'sync_cursor'")
            }
        }

        fun create(context: Context): AppDatabase =
            Room.databaseBuilder(context, AppDatabase::class.java, "wabrain.db")
                .addMigrations(MIGRATION_3_4, MIGRATION_4_5)
                // The database is a cache of server state: on a schema change, drop it and re-sync.
                .fallbackToDestructiveMigration(dropAllTables = true)
                .build()
    }
}
