ALTER TABLE "settings" ALTER COLUMN "trial_days" SET DEFAULT 0;--> statement-breakpoint
ALTER TABLE "settings" ALTER COLUMN "auto_create_threshold" SET DEFAULT 0.8;--> statement-breakpoint
-- Review decisions no longer calibrate a threshold: drop the stored calibrations.
DELETE FROM app_state WHERE key = 'task.calibration';
