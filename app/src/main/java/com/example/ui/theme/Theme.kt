package com.example.ui.theme

import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.unit.dp

val SilicaDarkColorScheme = darkColorScheme(
    primary = SilicaEmerald,
    onPrimary = SilicaOnEmerald,
    primaryContainer = SilicaEmeraldContainer,
    onPrimaryContainer = SilicaOnEmeraldContainer,
    secondary = SilicaCyan,
    onSecondary = SilicaOnCyan,
    secondaryContainer = SilicaCyanContainer,
    onSecondaryContainer = SilicaOnCyanContainer,
    tertiary = SilicaAmber,
    onTertiary = SilicaObsidian,
    tertiaryContainer = SilicaAmberContainer,
    onTertiaryContainer = SilicaOnAmberContainer,
    error = SilicaCrimson,
    onError = SilicaIce,
    errorContainer = SilicaCrimsonContainer,
    onErrorContainer = SilicaOnCrimsonContainer,
    background = SilicaObsidian,
    onBackground = SilicaIce,
    surface = SilicaCarbon,
    onSurface = SilicaIce,
    surfaceVariant = SilicaGraphite,
    onSurfaceVariant = SilicaSteel,
    surfaceContainerLowest = SilicaTerminalBg,
    surfaceContainerLow = SilicaCarbon,
    surfaceContainer = SilicaGraphite,
    surfaceContainerHigh = SilicaSlateElevated,
    outline = SilicaOutline,
    outlineVariant = SilicaHairline
)

val SilicaShapes = Shapes(
    extraSmall = RoundedCornerShape(8.dp),
    small = RoundedCornerShape(12.dp),
    medium = RoundedCornerShape(16.dp),
    large = RoundedCornerShape(20.dp),
    extraLarge = RoundedCornerShape(26.dp)
)

@Composable
fun SilicaClusterTheme(
    content: @Composable () -> Unit
) {
    MaterialTheme(
        colorScheme = SilicaDarkColorScheme,
        typography = Typography,
        shapes = SilicaShapes,
        content = content
    )
}

@Composable
fun ClusterLabTheme(
    darkTheme: Boolean = true,
    content: @Composable () -> Unit
) {
    SilicaClusterTheme(content = content)
}
