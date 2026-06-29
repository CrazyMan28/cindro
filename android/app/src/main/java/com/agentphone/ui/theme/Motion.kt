package com.agentphone.ui.theme

import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.ui.unit.IntOffset

object Motion {
    val EaseStandard = CubicBezierEasing(0.2f, 0.0f, 0.0f, 1.0f)
    val EaseEmphasized = CubicBezierEasing(0.3f, 0.0f, 0.0f, 1.0f)
    val EaseDecel = CubicBezierEasing(0.0f, 0.0f, 0.0f, 1.0f)

    fun <T> fast() = tween<T>(durationMillis = 150, easing = EaseStandard)
    fun <T> medium() = tween<T>(durationMillis = 250, easing = EaseStandard)
    fun <T> slow() = tween<T>(durationMillis = 400, easing = EaseEmphasized)

    fun <T> springGentle() = spring<T>(
        dampingRatio = Spring.DampingRatioLowBouncy,
        stiffness = Spring.StiffnessMediumLow
    )

    fun <T> springSnappy() = spring<T>(
        dampingRatio = Spring.DampingRatioNoBouncy,
        stiffness = Spring.StiffnessMedium
    )

    fun springOffset() = spring<IntOffset>(
        dampingRatio = Spring.DampingRatioLowBouncy,
        stiffness = Spring.StiffnessMediumLow
    )
}
