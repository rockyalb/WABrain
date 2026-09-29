package app.wabrain.widget

import android.content.Context
import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.res.stringResource
import androidx.lifecycle.lifecycleScope
import app.wabrain.R
import app.wabrain.appContainer
import app.wabrain.ui.common.TaskDraft
import app.wabrain.ui.common.TaskEditorDialog
import app.wabrain.ui.tasks.toNewTask
import app.wabrain.ui.theme.WabTheme
import kotlinx.coroutines.launch

/** Dialog-style quick add launched from the widget "+"; works offline (Room + outbox). */
class QuickAddActivity : ComponentActivity() {
    private var saving = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val container = appContainer
        setContent {
            WabTheme {
                val contexts by container.db.contexts().observeAll().collectAsState(initial = emptyList())
                val chats by container.db.chats().observeAll().collectAsState(initial = emptyList())
                val people by container.db.people().observeAll().collectAsState(initial = emptyList())
                TaskEditorDialog(
                    title = stringResource(R.string.task_new),
                    initial = TaskDraft(),
                    contexts = contexts,
                    chats = chats,
                    people = people,
                    showLink = true,
                    confirmLabel = stringResource(R.string.action_create),
                    onConfirm = { draft ->
                        saving = true
                        lifecycleScope.launch {
                            container.tasks.create(draft.toNewTask())
                            finish()
                        }
                    },
                    onDismiss = { if (!saving) finish() },
                )
            }
        }
    }

    companion object {
        fun intent(context: Context): Intent = Intent(context, QuickAddActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    }
}
