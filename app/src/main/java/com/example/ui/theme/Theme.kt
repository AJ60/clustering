package com.example.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable

private val DarkColorScheme = darkColorScheme(
    primary = StudioDarkPrimary,
    onPrimary = StudioDarkOnPrimary,
    primaryContainer = StudioDarkPrimaryContainer,
    onPrimaryContainer = StudioDarkOnPrimaryContainer,
    secondary = StudioDarkSecondary,
    onSecondary = StudioDarkOnSecondary,
    secondaryContainer = StudioDarkSecondaryContainer,
    onSecondaryContainer = StudioDarkOnSecondaryContainer,
    tertiary = StudioDarkTertiary,
    background = StudioDarkBackground,
    onBackground = StudioDarkOnBackground,
    surface = StudioDarkSurface,
    onSurface = StudioDarkOnSurface,
    surfaceVariant = StudioDarkSurfaceVariant,
    onSurfaceVariant = StudioDarkOnSurfaceVariant,
    outline = StudioDarkOutline
)

private val LightColorScheme = lightColorScheme(
    primary = StudioLightPrimary,
    onPrimary = StudioLightOnPrimary,
    primaryContainer = StudioLightPrimaryContainer,
    onPrimaryContainer = StudioLightOnPrimaryContainer,
    secondary = StudioLightSecondary,
    onSecondary = StudioLightOnSecondary,
    secondaryContainer = StudioLightSecondaryContainer,
    onSecondaryContainer = StudioLightOnSecondaryContainer,
    tertiary = StudioLightTertiary,
    background = StudioLightBackground,
    onBackground = StudioLightOnBackground,
    surface = StudioLightSurface,
    onSurface = StudioLightOnSurface,
    surfaceVariant = StudioLightSurfaceVariant,
    onSurfaceVariant = StudioLightOnSurfaceVariant,
    outline = StudioLightOutline
)

@Composable
fun ClusterLabTheme(
    darkTheme: Boolean = isSystemInDarkTheme(),
    content: @Composable () -> Unit
) {
    val colorScheme = if (darkTheme) DarkColorScheme else LightColorScheme

    MaterialTheme(
        colorScheme = colorScheme,
        typography = Typography,
        content = content
    )
}
