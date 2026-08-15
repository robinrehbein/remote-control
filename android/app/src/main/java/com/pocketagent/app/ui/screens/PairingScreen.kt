package com.pocketagent.app.ui.screens

import android.os.Build
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusDirection
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import com.pocketagent.app.PocketAgentApp
import com.pocketagent.app.R
import com.pocketagent.app.data.PairingApi
import com.pocketagent.app.ui.theme.ContentInset
import com.pocketagent.app.ui.theme.PillShape
import com.pocketagent.app.ui.theme.PrimaryButtonHeight
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

    val focus = LocalFocusManager.current

    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(MaterialTheme.colorScheme.background)
            .safeDrawingPadding()
            .imePadding()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = ContentInset, vertical = 32.dp),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Surface(
            shape = CircleShape,
            color = MaterialTheme.colorScheme.primaryContainer,
            modifier = Modifier.size(88.dp),
        ) {
            Box(contentAlignment = Alignment.Center) {
                Text(
                    text = "⌘",
                    style = MaterialTheme.typography.displaySmall,
                    color = MaterialTheme.colorScheme.onPrimaryContainer,
                )
            }
        }
        Text(
            text = "PocketAgent",
            style = MaterialTheme.typography.headlineLarge,
            modifier = Modifier.padding(top = 24.dp),
        )
        Text(
            text = "Steure Coding-Agenten von deinem Telefon aus",
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            textAlign = TextAlign.Center,
            modifier = Modifier.padding(top = 8.dp, bottom = 36.dp),
        )

        OutlinedTextField(
            value = state.serverUrl,
            onValueChange = { v -> vm.update { it.copy(serverUrl = v) } },
            label = { Text(stringResource(R.string.pairing_server_url)) },
            placeholder = { Text("https://pocketagent.example.com") },
            singleLine = true,
            keyboardOptions = KeyboardOptions(
                autoCorrectEnabled = false,
                keyboardType = KeyboardType.Uri,
                imeAction = ImeAction.Next,
            ),
            keyboardActions = KeyboardActions(onNext = { focus.moveFocus(FocusDirection.Down) }),
            shape = MaterialTheme.shapes.small,
            modifier = Modifier.fillMaxWidth(),
        )
        OutlinedTextField(
            value = state.code,
            onValueChange = { v -> vm.update { it.copy(code = v.filter { c -> c.isLetterOrDigit() }.lowercase()) } },
            label = { Text(stringResource(R.string.pairing_code)) },
            placeholder = { Text("xxxxxxxx") },
            singleLine = true,
            keyboardOptions = KeyboardOptions(
                autoCorrectEnabled = false,
                keyboardType = KeyboardType.Ascii,
                imeAction = ImeAction.Next,
            ),
            keyboardActions = KeyboardActions(onNext = { focus.moveFocus(FocusDirection.Down) }),
            shape = MaterialTheme.shapes.small,
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
            keyboardActions = KeyboardActions(
                onDone = {
                    focus.clearFocus()
                    vm.pair(onPaired)
                },
            ),
            shape = MaterialTheme.shapes.small,
            modifier = Modifier
                .fillMaxWidth()
                .padding(top = 12.dp),
        )

        state.error?.let { error ->
            Text(
                text = error,
                color = MaterialTheme.colorScheme.error,
                style = MaterialTheme.typography.bodySmall,
                textAlign = TextAlign.Center,
                modifier = Modifier.padding(top = 16.dp),
            )
        }

        Button(
            onClick = { focus.clearFocus(); vm.pair(onPaired) },
            enabled = !state.busy,
            shape = PillShape,
            modifier = Modifier
                .fillMaxWidth()
                .padding(top = 28.dp)
                .height(PrimaryButtonHeight),
        ) {
            if (state.busy) {
                CircularProgressIndicator(
                    strokeWidth = 2.dp,
                    color = MaterialTheme.colorScheme.onPrimary,
                    modifier = Modifier.size(18.dp),
                )
                Spacer(modifier = Modifier.width(8.dp))
            }
            Text(stringResource(R.string.pairing_button))
        }

        Text(
            text = "Den Pairing-Code erzeugst du auf deinem Server.",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            textAlign = TextAlign.Center,
            modifier = Modifier.padding(top = 20.dp),
        )
    }
}
