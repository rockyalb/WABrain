package app.wabrain.data.api

import java.io.File
import kotlinx.serialization.KSerializer
import kotlinx.serialization.descriptors.elementNames
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Test

/** Guards the names sent over the wire against the checked-in OpenAPI contract. */
class ContractFieldNamesTest {
    private val schemas by lazy {
        val contract = generateSequence(File(requireNotNull(System.getProperty("user.dir")))) { it.parentFile }
            .map { File(it, "packages/contracts/openapi.json") }
            .firstOrNull(File::isFile)
        assertNotNull("packages/contracts/openapi.json must be available to the Android test", contract)
        Json.parseToJsonElement(contract!!.readText()).jsonObject
            .getValue("components").jsonObject
            .getValue("schemas").jsonObject
    }

    private fun fields(schema: String): Set<String> =
        schemas.getValue(schema).jsonObject.getValue("properties").jsonObject.keys

    private fun <T> assertFields(schema: String, serializer: KSerializer<T>) {
        assertEquals(schema, fields(schema), serializer.descriptor.elementNames.toSet())
    }

    @Test
    fun domainAndSyncFieldsMatchOpenApi() {
        assertFields("Context", ContextDto.serializer())
        assertFields("Settings", SettingsDto.serializer())
        assertFields("Chat", ChatDto.serializer())
        assertFields("PersonFact", PersonFactDto.serializer())
        assertFields("Person", PersonDto.serializer())
        assertFields("Task", TaskDto.serializer())
        assertFields("TaskEvent", TaskEventDto.serializer())
        assertFields("ReviewItem", ReviewItemDto.serializer())
        assertFields("MessageView", MessageViewDto.serializer())
        assertFields("SyncResponse", SyncResponse.serializer())
    }

    @Test
    fun notificationFieldsMatchOpenApi() {
        assertFields("NotificationEvent", NotificationEventDto.serializer())
        assertFields("NotificationsResponse", NotificationsResponse.serializer())
        assertFields("NotificationAckRequest", NotificationAckRequest.serializer())
    }
}
