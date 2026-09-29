package app.wabrain.ui

import android.Manifest
import android.content.Intent
import android.os.Build
import android.widget.Toast
import androidx.activity.compose.LocalActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.NavigationBarItemDefaults
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.produceState
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.navigation.NavDestination.Companion.hasRoute
import androidx.navigation.NavGraph.Companion.findStartDestination
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.currentBackStackEntryAsState
import androidx.navigation.compose.rememberNavController
import androidx.navigation.toRoute
import app.wabrain.AppContainer
import app.wabrain.MainActivity
import app.wabrain.R
import app.wabrain.data.session.Session
import app.wabrain.push.PushController
import app.wabrain.ui.ask.AskScreen
import app.wabrain.ui.chats.ChatsScreen
import app.wabrain.ui.common.LoadingBox
import app.wabrain.ui.detail.ConversationScreen
import app.wabrain.ui.detail.TaskDetailScreen
import app.wabrain.ui.pairing.PairingScreen
import app.wabrain.ui.people.PeopleScreen
import app.wabrain.ui.people.PersonScreen
import app.wabrain.ui.settings.SettingsScreen
import app.wabrain.ui.tasks.TasksScreen
import app.wabrain.ui.theme.LocalGlass
import app.wabrain.ui.theme.MintBackdrop
import app.wabrain.ui.theme.WabIcons
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.map
import kotlin.reflect.KClass

private sealed class SessionState {
    data object Loading : SessionState()
    data object Unpaired : SessionState()
    data class Paired(val session: Session) : SessionState()
}

@Composable
fun AppRoot(container: AppContainer, pendingIntent: StateFlow<Intent?>, onIntentConsumed: () -> Unit) {
    val state by produceState<SessionState>(SessionState.Loading, container) {
        container.session.session.map { s -> if (s == null) SessionState.Unpaired else SessionState.Paired(s) }
            .collect { value = it }
    }
    val intent by pendingIntent.collectAsState()
    val pairLink = intent?.data?.takeIf { it.scheme == "wabrain" && it.host == "pair" }?.toString()

    when (state) {
        SessionState.Loading -> LoadingBox()
        SessionState.Unpaired -> {
            PairingScreen(container = container, initialLink = pairLink, onLinkConsumed = onIntentConsumed)
        }
        is SessionState.Paired -> {
            if (pairLink != null) {
                val context = LocalContext.current
                val message = stringResource(R.string.pairing_already_paired)
                LaunchedEffect(pairLink) {
                    Toast.makeText(context, message, Toast.LENGTH_LONG).show()
                    onIntentConsumed()
                }
            }
            MainScaffold(container, intent, onIntentConsumed)
        }
    }
}

private data class TopLevel(val route: Any, val routeClass: KClass<*>, val labelRes: Int, val icon: ImageVector)

private val topLevel = listOf(
    TopLevel(TasksRoute(), TasksRoute::class, R.string.nav_tasks, WabIcons.Tasks),
    TopLevel(PeopleRoute, PeopleRoute::class, R.string.nav_people, WabIcons.People),
    TopLevel(ChatsRoute, ChatsRoute::class, R.string.nav_chats, WabIcons.Chats),
    TopLevel(AskRoute, AskRoute::class, R.string.nav_ask, WabIcons.Ask),
    TopLevel(SettingsRoute, SettingsRoute::class, R.string.nav_settings, WabIcons.Settings),
)

@Composable
private fun MainScaffold(container: AppContainer, intent: Intent?, onIntentConsumed: () -> Unit) {
    val nav = rememberNavController()
    val backStack by nav.currentBackStackEntryAsState()
    val destination = backStack?.destination

    // Android 13+: ask once for notification permission after pairing.
    var askedNotifications by rememberSaveable { mutableStateOf(false) }
    val notificationLauncher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { }
    LaunchedEffect(Unit) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU && !askedNotifications) {
            askedNotifications = true
            notificationLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
    }

    // After pairing: offer UnifiedPush once (the 15-minute sync works without it).
    val activity = LocalActivity.current
    LaunchedEffect(Unit) {
        if (activity != null && !container.session.pushPrompted()) {
            container.session.markPushPrompted()
            if (PushController.currentDistributor(activity) == null) PushController.registerWithDefault(activity) { }
        }
    }

    // Notification / widget taps.
    LaunchedEffect(intent) {
        val i = intent ?: return@LaunchedEffect
        val taskId = i.getStringExtra(MainActivity.EXTRA_TASK_ID)
        val reviewId = i.getStringExtra(MainActivity.EXTRA_REVIEW_ID)
        when {
            taskId != null -> nav.navigate(TaskDetailRoute(taskId))
            reviewId != null || i.getBooleanExtra(MainActivity.EXTRA_OPEN_REVIEW, false) ->
                nav.navigate(TasksRoute(TaskTabs.REVIEW)) {
                    popUpTo(nav.graph.findStartDestination().id)
                    launchSingleTop = true
                }
            else -> Unit
        }
        if (i.data?.scheme != "wabrain") onIntentConsumed()
    }

    fun openTopLevel(route: Any) {
        nav.navigate(route) {
            popUpTo(nav.graph.findStartDestination().id) { saveState = true }
            launchSingleTop = true
            restoreState = true
        }
    }

    val showBottomBar = topLevel.any { t -> destination?.hasRoute(t.routeClass) == true }
    val glass = LocalGlass.current
    MintBackdrop {
        Scaffold(
            containerColor = Color.Transparent,
            bottomBar = {
                if (showBottomBar) {
                    // Five equal segments; each item fills its fifth of the bar.
                    NavigationBar(
                        containerColor = glass.navBar,
                        tonalElevation = 0.dp,
                        modifier = Modifier.drawBehind {
                            drawLine(glass.cardBorder, Offset(0f, 0f), Offset(size.width, 0f), strokeWidth = 1.dp.toPx())
                        },
                    ) {
                        topLevel.forEach { item ->
                            NavigationBarItem(
                                selected = destination?.hasRoute(item.routeClass) == true,
                                onClick = { openTopLevel(item.route) },
                                icon = { Icon(item.icon, contentDescription = null) },
                                label = { Text(stringResource(item.labelRes), maxLines = 1) },
                                colors = NavigationBarItemDefaults.colors(
                                    selectedIconColor = MaterialTheme.colorScheme.primary,
                                    selectedTextColor = MaterialTheme.colorScheme.onSurface,
                                    indicatorColor = glass.navIndicator,
                                    unselectedIconColor = MaterialTheme.colorScheme.onSurfaceVariant,
                                    unselectedTextColor = MaterialTheme.colorScheme.onSurfaceVariant,
                                ),
                            )
                        }
                    }
                }
            },
        ) { padding ->
            val bottom = PaddingValues(bottom = padding.calculateBottomPadding())
            NavHost(nav, startDestination = TasksRoute(), modifier = Modifier.padding(bottom).consumeWindowInsets(bottom)) {
                composable<TasksRoute> { entry ->
                    TasksScreen(
                        container = container,
                        initialTab = entry.toRoute<TasksRoute>().tab,
                        onOpenTask = { nav.navigate(TaskDetailRoute(it)) },
                        onOpenConversation = { chatId, messageId -> nav.navigate(ConversationRoute(chatId, messageId)) },
                        onOpenAsk = { openTopLevel(AskRoute) },
                    )
                }
                composable<TaskDetailRoute> { entry ->
                    TaskDetailScreen(
                        container = container,
                        taskId = entry.toRoute<TaskDetailRoute>().id,
                        onBack = { nav.popBackStack() },
                        onOpenConversation = { chatId, messageId -> nav.navigate(ConversationRoute(chatId, messageId)) },
                    )
                }
                composable<ConversationRoute> { entry ->
                    val route = entry.toRoute<ConversationRoute>()
                    ConversationScreen(container, route.chatId, route.messageId, onBack = { nav.popBackStack() })
                }
                composable<PeopleRoute> {
                    PeopleScreen(container, onOpenPerson = { nav.navigate(PersonRoute(it)) })
                }
                composable<PersonRoute> { entry ->
                    PersonScreen(
                        container,
                        entry.toRoute<PersonRoute>().id,
                        onBack = { nav.popBackStack() },
                        onOpenConversation = { chatId, messageId -> nav.navigate(ConversationRoute(chatId, messageId)) },
                    )
                }
                composable<ChatsRoute> { ChatsScreen(container) }
                composable<AskRoute> {
                    AskScreen(container, onOpenConversation = { chatId, messageId -> nav.navigate(ConversationRoute(chatId, messageId)) })
                }
                composable<SettingsRoute> { SettingsScreen(container) }
            }
        }
    }
}
