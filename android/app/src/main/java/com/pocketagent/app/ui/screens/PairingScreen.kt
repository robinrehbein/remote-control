package com.pocketagent.app.ui.screens

import android.os.Build
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import com.pocketagent.app.PocketAgentApp
import com.pocketagent.app.R
import com.pocketagent.app.data.PairingApi
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch

class PairingViewModel : ViewModel() {

    data class UiState(
        val serverUrl: String = "",
        val code: String = "",
        val deviceName: String = Build.MODEL ?: "Android",
        val busy: Boolean = false,
        val error: String? = null,
    )

    private val _state = MutableStateFlow(UiState())
    val state: StateFlow<UiState> = _state

    lateinit var app: PocketAgentApp

    fun update(transform: (UiState) -> UiState) {
        _state.value = transform(_state.value)
    }

    fun pair(onSuccess: () -> Unit) {
        val s = _state.value
        val container = app.container
        if (s.busy) return
        if (s.serverUrl.isBlank() || s.code.isBlank() || s.deviceName.isBlank()) {
            _state.value = s.copy(error = "Bitte alle Felder ausfüllen")
            return
        }
        _state.value = s.copy(busy = true, error = null)
        viewModelScope.launch {
            val result = container.pairingApi.confirm(s.serverUrl.trim(), s.code.trim(), s.deviceName.trim())
            result.fold(
                onSuccess = { response ->
                    container.tokenStore.save(
                        serverUrl = PairingApi.normalizeUrl(s.serverUrl.trim()),
                        deviceId = response.deviceId,
                        deviceName = s.deviceName.trim(),
                        deviceToken = response.deviceToken,
                    )
                    _state.value = _state.value.copy(busy = false)
                    onSuccess()
                },
                onFailure = { t ->
                    _state.value = _state.value.copy(busy = false, error = t.message ?: "Koppeln fehlgeschlagen")
                },
            )
        }
    }
}

@Composable
fun PairingScreen(onPaired: () -> Unit) {
    val app = LocalContext.current.applicationContext as PocketAgentApp
    val vm: PairingViewModel = viewModel { PairingViewModel().also { it.app = app } }
    val state by vm.state.collectAsState()

    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(24.dp),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text(
            text = stringResource(R.string.pairing_title),
            style = MaterialTheme.typography.titleLarge,
        )
        Text(
            text = stringResource(R.string.pairing_hint_code),
            style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace),
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.padding(top = 8.dp, bottom = 24.dp),
        )

        OutlinedTextField(
            value = state.serverUrl,
            onValueChange = { v -> vm.update { it.copy(serverUrl = v) } },
            label = { Text(stringResource(R.string.pairing_server_url)) },
            placeholder = { Text("https://orchestrator.example.com") },
            singleLine = true,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri, imeAction = ImeAction.Next),
            modifier = Modifier.fillMaxWidth(),
        )
        OutlinedTextField(
            value = state.code,
            onValueChange = { v -> vm.update { it.copy(code = v.uppercase()) } },
            label = { Text(stringResource(R.string.pairing_code)) },
            placeholder = { Text("XXXXXXXX") },
            singleLine = true,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Ascii, imeAction = ImeAction.Next),
            modifier = Modifier
                .fillMaxWidth()
                .padding(top = 12.dp),
        )
        OutlinedTextField(
            value = state.deviceName,
            onValueChange = { v -> vm.update { it.copy(deviceName = v) } },
            label = { Text(stringResource(R.string.pairing_device_name)) },
            singleLine = true,
            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
            modifier = Modifier
                .fillMaxWidth()
                .padding(top = 12.dp),
        )

        state.error?.let { error ->
            Text(
                text = error,
                color = MaterialTheme.colorScheme.error,
                style = MaterialTheme.typography.bodySmall,
                modifier = Modifier.padding(top = 16.dp),
            )
        }

        Button(
            onClick = { vm.pair(onPaired) },
            enabled = !state.busy,
            modifier = Modifier
                .fillMaxWidth()
                .padding(top = 24.dp),
        ) {
            if (state.busy) {
                CircularProgressIndicator(
                    modifier = Modifier.padding(end = 8.dp),
                    strokeWidth = 2.dp,
                )
            }
            Text(stringResource(R.string.pairing_button))
        }
    }
}
