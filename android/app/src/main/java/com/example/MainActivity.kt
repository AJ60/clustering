package com.example

import android.graphics.Color
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import com.example.data.ClusterLabDatabase
import com.example.data.DatasetRepository
import com.example.data.ThemePreferencesRepository
import com.example.ui.ClusteringStudioScreen
import com.example.ui.ClusteringViewModel
import com.example.ui.theme.ClusterLabTheme

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent {
            val repository = remember {
                val db = ClusterLabDatabase.getInstance(applicationContext)
                DatasetRepository(db.savedDatasetDao())
            }
            val themePreferences = remember {
                ThemePreferencesRepository(applicationContext)
            }
            val clusteringViewModel: ClusteringViewModel = viewModel(
                factory = ClusteringViewModel.Factory(repository, themePreferences)
            )
            val uiState by clusteringViewModel.uiState.collectAsStateWithLifecycle()

            LaunchedEffect(uiState.isDarkTheme) {
                if (uiState.isDarkTheme) {
                    enableEdgeToEdge(
                        statusBarStyle = SystemBarStyle.dark(Color.TRANSPARENT),
                        navigationBarStyle = SystemBarStyle.dark(Color.TRANSPARENT)
                    )
                } else {
                    enableEdgeToEdge(
                        statusBarStyle = SystemBarStyle.light(Color.TRANSPARENT, Color.TRANSPARENT),
                        navigationBarStyle = SystemBarStyle.light(Color.TRANSPARENT, Color.TRANSPARENT)
                    )
                }
            }

            ClusterLabTheme(darkTheme = uiState.isDarkTheme) {
                ClusteringStudioScreen(viewModel = clusteringViewModel)
            }
        }
    }
}
