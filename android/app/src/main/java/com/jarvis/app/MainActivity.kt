package com.jarvis.app

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.Surface
import androidx.compose.ui.Modifier
import androidx.lifecycle.viewmodel.compose.viewModel
import com.jarvis.app.ui.pairing.PairScreen
import com.jarvis.app.ui.pairing.PairingViewModel
import com.jarvis.app.ui.theme.JarvisTheme

class MainActivity : ComponentActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        setContent {
            JarvisTheme {
                Surface(modifier = Modifier.fillMaxSize()) {
                    val vm: PairingViewModel = viewModel(
                        factory = PairingViewModel.factory(application as JarvisApp)
                    )
                    PairScreen(viewModel = vm)
                }
            }
        }
    }
}
