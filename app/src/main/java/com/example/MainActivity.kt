package com.example

import android.graphics.Color
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.runtime.remember
import androidx.lifecycle.viewmodel.compose.viewModel
import com.example.data.ClusterLabDatabase
import com.example.data.SilicaPreferencesRepository
import com.example.data.SilicaRepository
import com.example.ui.silica.SilicaAppScreen
import com.example.ui.silica.SilicaViewModel
import com.example.ui.theme.SilicaClusterTheme

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge(
            statusBarStyle = SystemBarStyle.dark(Color.TRANSPARENT),
            navigationBarStyle = SystemBarStyle.dark(Color.TRANSPARENT)
        )
        setContent {
            val repository = remember {
                val db = ClusterLabDatabase.getInstance(applicationContext)
                val prefs = SilicaPreferencesRepository(applicationContext)
                SilicaRepository(
                    chatDao = db.silicaChatDao(),
                    peerDao = db.savedPeerDao(),
                    prefs = prefs
                )
            }
            val silicaViewModel: SilicaViewModel = viewModel(
                factory = SilicaViewModel.Factory(application, repository)
            )

            SilicaClusterTheme {
                SilicaAppScreen(viewModel = silicaViewModel)
            }
        }
    }
}
