import { getReviewDetail, getTaskDetail, listPendingReview, listTasks } from "@wabrain/db";
import { Hono } from "hono";
import type { AppDeps, AppEnv } from "../deps.js";
import {
  AcceptReviewRequestSchema,
  CreateTaskRequestSchema,
  PageQuerySchema,
  TaskListQuerySchema,
  UpdateTaskRequestSchema,
} from "../http/schemas.js";
import { jsonBody, queryParams } from "../http/validate.js";

export function taskRoutes(deps: AppDeps) {
  const app = new Hono<AppEnv>();
  const { database, tasks } = deps;

  app.get("/tasks", async (c) => c.json(await listTasks(database.db, queryParams(c, TaskListQuerySchema))));

  app.get("/tasks/:id", async (c) => c.json(await getTaskDetail(database.db, c.req.param("id"))));

  app.post("/tasks", async (c) => {
    const body = await jsonBody(c, CreateTaskRequestSchema);
    const { task, created } = await tasks.createManualTask(body);
    return c.json(task, created ? 201 : 200);
  });

  app.patch("/tasks/:id", async (c) => {
    const body = await jsonBody(c, UpdateTaskRequestSchema);
    return c.json(await tasks.updateTask(c.req.param("id"), body));
  });

  app.post("/tasks/:id/complete", async (c) => c.json(await tasks.setStatus(c.req.param("id"), "done")));
  app.post("/tasks/:id/reopen", async (c) => c.json(await tasks.setStatus(c.req.param("id"), "open")));
  app.post("/tasks/:id/cancel", async (c) => c.json(await tasks.setStatus(c.req.param("id"), "cancelled")));

  app.post("/task-events/:id/undo", async (c) => c.json(await tasks.undoEvent(c.req.param("id"))));

  app.get("/review", async (c) => c.json(await listPendingReview(database.db, queryParams(c, PageQuerySchema))));

  app.get("/review/:id", async (c) => c.json(await getReviewDetail(database.db, c.req.param("id"))));

  app.post("/review/:id/accept", async (c) => {
    const body = await jsonBody(c, AcceptReviewRequestSchema);
    // TaskService writes the audit event for review decisions and undo.
    return c.json(await tasks.acceptReview(c.req.param("id"), body.edits ?? {}, body.closeAs));
  });

  app.post("/review/:id/reject", async (c) => {
    return c.json(await tasks.rejectReview(c.req.param("id")));
  });

  return app;
}
