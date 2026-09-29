package app.wabrain.data.db

import android.content.Context
import androidx.room.Database
import androidx.room.Room
import androidx.room.RoomDatabase

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
    version = 2,
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
        fun create(context: Context): AppDatabase =
            Room.databaseBuilder(context, AppDatabase::class.java, "wabrain.db")
                // The database is a cache of server state: on a schema change, drop it and re-sync.
                .fallbackToDestructiveMigration(dropAllTables = true)
                .build()
    }
}
