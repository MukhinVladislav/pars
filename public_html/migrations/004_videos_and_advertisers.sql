-- 004_videos_and_advertisers.sql
-- Видео-очередь + рекламодатели

CREATE TABLE IF NOT EXISTS `videos` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `video_id` VARCHAR(32) NOT NULL,
  `video_url` VARCHAR(255) NOT NULL,
  `title` VARCHAR(500) NOT NULL DEFAULT '',
  `query_text` VARCHAR(255) NULL DEFAULT NULL,
  `channel_url` VARCHAR(255) NULL DEFAULT NULL,
  `video_date` INT NULL DEFAULT NULL,
  `status` ENUM('new','processing','done','error') NOT NULL DEFAULT 'new',
  `parse_attempts` INT NOT NULL DEFAULT 0,
  `last_error` VARCHAR(500) NULL DEFAULT NULL,
  `created_at` INT NOT NULL,
  `updated_at` INT NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_video_id` (`video_id`),
  KEY `idx_status_updated` (`status`, `updated_at`),
  KEY `idx_query_text` (`query_text`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `advertisers` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `company_name` VARCHAR(255) NOT NULL,
  `company_type` ENUM('ООО','ИП','АО') NOT NULL,
  `video_id` BIGINT UNSIGNED NOT NULL,
  `source_video_url` VARCHAR(255) NOT NULL,
  `source_video_date` INT NULL DEFAULT NULL,
  `created_at` INT NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_company_name` (`company_name`),
  KEY `idx_video_id` (`video_id`),
  CONSTRAINT `fk_advertisers_video_id` FOREIGN KEY (`video_id`) REFERENCES `videos` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
