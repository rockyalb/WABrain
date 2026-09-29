package app.wabrain.domain

import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import java.net.URI
import java.net.URLDecoder

/** A parsed `wabrain://pair?server=<https base URL>&code=<secret>` setup link. */
data class PairingLink(val server: HttpUrl, val code: String) {

    sealed class Error {
        data object NotAPairingLink : Error()
        data object MissingServer : Error()
        data object InsecureServer : Error()
        data object InvalidServer : Error()
        data object InvalidCode : Error()
    }

    sealed class Result {
        data class Ok(val link: PairingLink) : Result()
        data class Invalid(val error: Error) : Result()
    }

    companion object {
        const val MIN_CODE_LENGTH = 32
        private val LOCAL_HOSTS = setOf("localhost", "127.0.0.1", "10.0.2.2", "[::1]", "::1")

        /**
         * Parses a scanned or pasted setup link. The server must be https; plain
         * http is accepted only for a loopback/emulator host when
         * [allowInsecureLocalhost] is set (debug builds).
         */
        fun parse(raw: String, allowInsecureLocalhost: Boolean): Result {
            val text = raw.trim()
            val uri = runCatching { URI(text) }.getOrNull()
                ?: return Result.Invalid(Error.NotAPairingLink)
            if (!uri.scheme.equals("wabrain", ignoreCase = true) || !uri.host.equals("pair", ignoreCase = true)) {
                return Result.Invalid(Error.NotAPairingLink)
            }
            val params = parseQuery(uri.rawQuery)
            val serverRaw = params["server"]?.takeIf { it.isNotBlank() }
                ?: return Result.Invalid(Error.MissingServer)
            val code = params["code"]?.trim().orEmpty()

            val server = serverRaw.toHttpUrlOrNull()
                ?: return Result.Invalid(Error.InvalidServer)
            if (server.username.isNotEmpty() || server.password.isNotEmpty() || server.query != null || server.fragment != null) {
                return Result.Invalid(Error.InvalidServer)
            }
            val secureEnough = server.isHttps || (allowInsecureLocalhost && server.host in LOCAL_HOSTS)
            if (!secureEnough) return Result.Invalid(Error.InsecureServer)
            if (code.length < MIN_CODE_LENGTH || code.any { it.isWhitespace() }) {
                return Result.Invalid(Error.InvalidCode)
            }
            // Normalize to a base URL ending in "/" so relative API paths resolve under it.
            val base = if (server.encodedPath.endsWith("/")) server else server.newBuilder().addPathSegment("").build()
            return Result.Ok(PairingLink(base, code))
        }

        private fun parseQuery(rawQuery: String?): Map<String, String> {
            if (rawQuery.isNullOrEmpty()) return emptyMap()
            return rawQuery.split('&').mapNotNull { part ->
                val idx = part.indexOf('=')
                if (idx <= 0) return@mapNotNull null
                val key = URLDecoder.decode(part.substring(0, idx), "UTF-8")
                val value = URLDecoder.decode(part.substring(idx + 1), "UTF-8")
                key to value
            }.toMap()
        }
    }
}
