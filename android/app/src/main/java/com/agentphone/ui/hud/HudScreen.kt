package com.agentphone.ui.hud

import android.annotation.SuppressLint
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import com.agentphone.ui.state.AppViewModel

/**
 * The 2026 cyberpunk / Jarvis ops HUD, rendered inside the app as a WebView
 * pointed at the server's `/dashboard`. The phone already knows the server URL +
 * device token, so we inject them into the page's sessionStorage (the keys the
 * dashboard reads: `ap_token` / `ap_ext`) and reload once, which auto-logs-in —
 * no token paste needed.
 */
@SuppressLint("SetJavaScriptEnabled")
@Composable
fun HudScreen(vm: AppViewModel) {
    val appSettings by vm.settings.collectAsState()
    val baseUrl = appSettings.serverUrl.trim().trimEnd('/')
    val token = appSettings.token
    val ext = appSettings.extension.ifBlank { "100" }

    if (baseUrl.isBlank() || baseUrl.contains("TAILSCALE_IP")) {
        Box(Modifier.fillMaxSize().padding(24.dp), contentAlignment = Alignment.Center) {
            Text(
                "Set your server URL in Settings to load the ops HUD.",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onBackground
            )
        }
        return
    }

    val context = LocalContext.current
    val injected = remember { mutableStateOf(false) }
    val webView = remember {
        WebView(context).apply {
            this.settings.javaScriptEnabled = true
            this.settings.domStorageEnabled = true
            webViewClient = object : WebViewClient() {
                override fun onPageFinished(view: WebView, url: String?) {
                    if (!injected.value) {
                        injected.value = true
                        val t = token.replace("\\", "\\\\").replace("'", "\\'")
                        val e = ext.replace("\\", "\\\\").replace("'", "\\'")
                        view.evaluateJavascript(
                            "try{sessionStorage.setItem('ap_token','$t');sessionStorage.setItem('ap_ext','$e');}catch(e){}",
                            null
                        )
                        view.reload()
                    }
                }
            }
            loadUrl("$baseUrl/dashboard")
        }
    }

    AndroidView(modifier = Modifier.fillMaxSize(), factory = { webView })
}
