-- 001_query_learning_and_locking.sql
-- Apply once in your MySQL/MariaDB database (ci70535_yt)

-- 1) Add source_query to chanels
ALTER TABLE `chanels`
  ADD COLUMN IF NOT EXISTS `source_query` VARCHAR(255) NULL DEFAULT NULL;

-- 2) Queries table (self-learning search queue)
CREATE TABLE IF NOT EXISTS `queries` (
  `query` VARCHAR(255) NOT NULL,
  `weight` INT NOT NULL DEFAULT 1,
  `tries` INT NOT NULL DEFAULT 0,
  `wins` INT NOT NULL DEFAULT 0,
  `disabled` TINYINT(1) NOT NULL DEFAULT 0,
  `last_used_at` INT NULL DEFAULT NULL,
  `created_at` INT NOT NULL DEFAULT 0,
  PRIMARY KEY (`query`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- 3) Optional negatives table (stop-words)
CREATE TABLE IF NOT EXISTS `negatives` (
  `term` VARCHAR(255) NOT NULL,
  `weight` INT NOT NULL DEFAULT 1,
  `created_at` INT NOT NULL DEFAULT 0,
  PRIMARY KEY (`term`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- 4) Helpful index for queue scan
CREATE INDEX IF NOT EXISTS `idx_chanels_status` ON `chanels` (`status`);
