package com.gamelle.gamelle_chat

import android.app.Application

class GamelleApp : Application() {
    override fun onCreate() {
        PersistRescue.rescue(filesDir)
        super.onCreate()
    }
}
