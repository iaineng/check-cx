-- =============================================================================
-- 数据迁移：将现有 check_configs 的 request_header/metadata 归并到模板
-- 目标：为已有配置批量生成模板并回填 template_id
-- 策略：
--   1) 按 (type, request_header, metadata) 去重生成模板
--   2) 使用稳定哈希名 legacy-<md5>，保证可重复执行
--   3) 默认仅回填 template_id，不清空原字段，确保零破坏
-- =============================================================================

BEGIN;

-- 1) 基于现有配置生成模板（仅处理尚未绑定 template_id 的记录）
WITH candidate_configs AS (
  SELECT
    type,
    request_header,
    metadata
  FROM public.check_configs
  WHERE template_id IS NULL
    AND (request_header IS NOT NULL OR metadata IS NOT NULL)
  GROUP BY type, request_header, metadata
),
seed_templates AS (
  SELECT
    'legacy-' || type::text || '-' || md5(
      type::text || '|' || coalesce(request_header::text, '{}') || '|' || coalesce(metadata::text, '{}')
    ) AS name,
    type,
    request_header,
    metadata
  FROM candidate_configs
)
INSERT INTO public.check_request_templates (name, type, request_header, metadata)
SELECT name, type, request_header, metadata
FROM seed_templates
ON CONFLICT (name) DO UPDATE
SET
  type = EXCLUDED.type,
  request_header = EXCLUDED.request_header,
  metadata = EXCLUDED.metadata;

-- 2) 将 check_configs 回填到对应模板
UPDATE public.check_configs AS c
SET template_id = t.id
FROM public.check_request_templates AS t
WHERE c.template_id IS NULL
  AND (c.request_header IS NOT NULL OR c.metadata IS NOT NULL)
  AND t.name = 'legacy-' || c.type::text || '-' || md5(
    c.type::text || '|' || coalesce(c.request_header::text, '{}') || '|' || coalesce(c.metadata::text, '{}')
  );

COMMIT;

-- -------------------------------
-- 可选步骤（默认不执行）：
-- 若你确认要“完全迁移到模板”，可在验证后执行以下 SQL，清空实例重复字段。
-- 注意：仅清空与模板完全一致的字段，避免误删实例差异。
-- -------------------------------
-- UPDATE public.check_configs AS c
-- SET
--   request_header = NULL,
--   metadata = NULL
-- FROM public.check_request_templates AS t
-- WHERE c.template_id = t.id
--   AND c.request_header IS NOT DISTINCT FROM t.request_header
--   AND c.metadata IS NOT DISTINCT FROM t.metadata;

-- -------------------------------
-- 验证 SQL（手工执行）
-- -------------------------------
-- SELECT COUNT(*) AS templated_configs
-- FROM public.check_configs
-- WHERE template_id IS NOT NULL;
--
-- SELECT id, name, template_id, request_header, metadata
-- FROM public.check_configs
-- ORDER BY created_at DESC
-- LIMIT 20;
