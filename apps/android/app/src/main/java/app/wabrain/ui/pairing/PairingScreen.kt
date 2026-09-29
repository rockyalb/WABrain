package app.wabrain.ui.pairing

import android.Manifest
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import app.wabrain.AppContainer
import app.wabrain.BuildConfig
import app.wabrain.R
import app.wabrain.domain.PairingLink
import app.wabrain.ui.common.ErrorBanner
import app.wabrain.ui.common.errorText
import kotlinx.coroutines.launch

/** First-run screen: scan the setup QR code or paste the pairing link. */
@Composable
fun PairingScreen(container: AppContainer, initialLink: String?, onLinkConsumed: () -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val revoked by container.session.revoked.collectAsState(initial = false)
    var link by rememberSaveable { mutableStateOf("") }
    var deviceName by rememberSaveable { mutableStateOf(container.pairing.defaultDeviceName()) }
    var scanning by rememberSaveable { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    var parseError by remember { mutableStateOf<PairingLink.Error?>(null) }
    var apiError by remember { mutableStateOf<Throwable?>(null) }

    val cameraLauncher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        scanning = granted
    }

    fun submit(raw: String) {
        when (val result = PairingLink.parse(raw, allowInsecureLocalhost = BuildConfig.DEBUG)) {
            is PairingLink.Result.Invalid -> parseError = result.error
            is PairingLink.Result.Ok -> {
                parseError = null
                apiError = null
                busy = true
                scope.launch {
                    try {
                        container.pairing.pair(result.link, deviceName)
                    } catch (e: Exception) {
                        apiError = e
                    } finally {
                        busy = false
                    }
                }
            }
        }
    }

    LaunchedEffect(initialLink) {
        if (initialLink != null) {
            link = initialLink
            onLinkConsumed()
            submit(initialLink)
        }
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .safeDrawingPadding()
            .verticalScroll(rememberScrollState())
            .padding(24.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        Text(stringResource(R.string.pairing_title), style = MaterialTheme.typography.headlineMedium)
        Text(stringResource(R.string.pairing_intro), style = MaterialTheme.typography.bodyLarge)
        if (revoked) ErrorBanner(stringResource(R.string.pairing_revoked))

        if (scanning) {
            QrScanner(
                onResult = { text ->
                    scanning = false
                    link = text
                    submit(text)
                },
                modifier = Modifier.fillMaxWidth().aspectRatio(1f),
            )
            TextButton(onClick = { scanning = false }) { Text(stringResource(R.string.action_cancel)) }
        } else {
            Button(
                enabled = !busy,
                onClick = {
                    if (ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
                        scanning = true
                    } else {
                        cameraLauncher.launch(Manifest.permission.CAMERA)
                    }
                },
                modifier = Modifier.fillMaxWidth(),
            ) { Text(stringResource(R.string.pairing_scan)) }
        }

        Text(stringResource(R.string.pairing_paste_hint), style = MaterialTheme.typography.bodyMedium)
        OutlinedTextField(
            value = link,
            onValueChange = { link = it.trim(); parseError = null },
            label = { Text(stringResource(R.string.pairing_link_label)) },
            modifier = Modifier.fillMaxWidth(),
            singleLine = true,
        )
        OutlinedTextField(
            value = deviceName,
            onValueChange = { deviceName = it.take(80) },
            label = { Text(stringResource(R.string.pairing_device_name)) },
            modifier = Modifier.fillMaxWidth(),
            singleLine = true,
        )
        OutlinedButton(enabled = !busy && link.isNotBlank(), onClick = { submit(link) }, modifier = Modifier.fillMaxWidth()) {
            Text(stringResource(R.string.pairing_connect))
        }
        if (busy) CircularProgressIndicator()
        parseError?.let { ErrorBanner(stringResource(pairingErrorText(it))) }
        apiError?.let { ErrorBanner(stringResource(R.string.pairing_failed, errorText(it))) }
        Text(stringResource(R.string.pairing_privacy), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

private fun pairingErrorText(error: PairingLink.Error): Int = when (error) {
    PairingLink.Error.NotAPairingLink -> R.string.pairing_error_not_link
    PairingLink.Error.MissingServer -> R.string.pairing_error_missing_server
    PairingLink.Error.InsecureServer -> R.string.pairing_error_insecure
    PairingLink.Error.InvalidServer -> R.string.pairing_error_invalid_server
    PairingLink.Error.InvalidCode -> R.string.pairing_error_invalid_code
}
