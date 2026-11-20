package com.example.data

import android.content.Context
import androidx.room.Database
import androidx.room.Room
import androidx.room.RoomDatabase

@Database(entities = [SavedDatasetEntity::class], version = 1, exportSchema = false)
abstract class ClusterLabDatabase : RoomDatabase() {
    abstract fun savedDatasetDao(): SavedDatasetDao

    companion object {
        @Volatile
        private var INSTANCE: ClusterLabDatabase? = null

        fun getInstance(context: Context): ClusterLabDatabase {
            return INSTANCE ?: synchronized(this) {
                val instance = Room.databaseBuilder(
                    context.applicationContext,
                    ClusterLabDatabase::class.java,
                    "clusterlab_studio.db"
                ).fallbackToDestructiveMigration().build()
                INSTANCE = instance
                instance
            }
        }
    }
}
