-- =============================================================================
-- 迁移：为 check_configs 引入请求模板（public + optional dev schema）
-- 目标：实现 request_header / metadata 的模板复用，并保持旧字段兼容
-- =============================================================================

-- ---------------------------------
-- public schema
-- ---------------------------------

CREATE TABLE IF NOT EXISTS public.check_request_templates (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name text NOT NULL UNIQUE,
    type public.provider_type NOT NULL,
    request_header jsonb,
    metadata jsonb,
    created_at timestamptz DEFAULT now(),
    updated_at timestamptz DEFAULT now()
);

ALTER TABLE public.check_request_templates
    ADD COLUMN IF NOT EXISTS type public.provider_type;

COMMENT ON TABLE public.check_request_templates IS '请求模板表，提供可复用的请求头和 metadata 默认值';
COMMENT ON COLUMN public.check_request_templates.id IS '模板 UUID';
COMMENT ON COLUMN public.check_request_templates.name IS '模板名称（唯一）';
COMMENT ON COLUMN public.check_request_templates.type IS '模板提供商类型: openai, gemini, anthropic';
COMMENT ON COLUMN public.check_request_templates.request_header IS '模板默认请求头 (JSONB)';
COMMENT ON COLUMN public.check_request_templates.metadata IS '模板默认 metadata，请求体参数 (JSONB)';
COMMENT ON COLUMN public.check_request_templates.created_at IS '创建时间';
COMMENT ON COLUMN public.check_request_templates.updated_at IS '更新时间';

ALTER TABLE public.check_configs
    ADD COLUMN IF NOT EXISTS template_id uuid;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'check_configs_template_id_fkey'
          AND conrelid = 'public.check_configs'::regclass
    ) THEN
        ALTER TABLE public.check_configs
            ADD CONSTRAINT check_configs_template_id_fkey
            FOREIGN KEY (template_id)
            REFERENCES public.check_request_templates(id)
            ON DELETE SET NULL;
    END IF;
END;
$$;

COMMENT ON COLUMN public.check_configs.template_id IS '请求模板 ID，可为空；实例配置优先级高于模板';

CREATE INDEX IF NOT EXISTS idx_check_configs_template_id
    ON public.check_configs (template_id);

ALTER TABLE public.check_request_templates ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.validate_check_config_template_type()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    template_type public.provider_type;
BEGIN
    IF NEW.template_id IS NULL THEN
        RETURN NEW;
    END IF;

    SELECT type
    INTO template_type
    FROM public.check_request_templates
    WHERE id = NEW.template_id;

    IF template_type IS NULL THEN
        RETURN NEW;
    END IF;

    IF template_type <> NEW.type THEN
        RAISE EXCEPTION '模板类型不匹配: config.type=%, template.type=%', NEW.type, template_type;
    END IF;

    RETURN NEW;
END;
$$;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE p.proname = 'update_updated_at_column'
          AND n.nspname = 'public'
    ) AND NOT EXISTS (
        SELECT 1
        FROM pg_trigger
        WHERE tgname = 'update_check_request_templates_updated_at'
          AND tgrelid = 'public.check_request_templates'::regclass
    ) THEN
        CREATE TRIGGER update_check_request_templates_updated_at
            BEFORE UPDATE ON public.check_request_templates
            FOR EACH ROW
            EXECUTE FUNCTION public.update_updated_at_column();
    END IF;
END;
$$;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_trigger
        WHERE tgname = 'validate_check_configs_template_type'
          AND tgrelid = 'public.check_configs'::regclass
    ) THEN
        CREATE TRIGGER validate_check_configs_template_type
            BEFORE INSERT OR UPDATE OF template_id, type ON public.check_configs
            FOR EACH ROW
            EXECUTE FUNCTION public.validate_check_config_template_type();
    END IF;
END;
$$;

-- ---------------------------------
-- dev schema（仅在存在 dev schema 时执行）
-- ---------------------------------

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'dev')
       AND EXISTS (
           SELECT 1
           FROM pg_class c
           JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = 'dev'
             AND c.relname = 'check_configs'
             AND c.relkind = 'r'
       ) THEN
        EXECUTE '
            CREATE TABLE IF NOT EXISTS dev.check_request_templates (
                id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
                name text NOT NULL UNIQUE,
                type dev.provider_type NOT NULL,
                request_header jsonb,
                metadata jsonb,
                created_at timestamptz DEFAULT now(),
                updated_at timestamptz DEFAULT now()
            )
        ';

        EXECUTE '
            COMMENT ON TABLE dev.check_request_templates IS
            ''请求模板表 - 存储可复用请求头和 metadata 默认值''
        ';

        EXECUTE '
            ALTER TABLE dev.check_request_templates
            ADD COLUMN IF NOT EXISTS type dev.provider_type
        ';

        EXECUTE '
            COMMENT ON COLUMN dev.check_request_templates.type IS
            ''模板提供商类型 - 必须与 check_configs.type 一致''
        ';

        EXECUTE '
            ALTER TABLE dev.check_configs
            ADD COLUMN IF NOT EXISTS template_id uuid
        ';

        EXECUTE '
            COMMENT ON COLUMN dev.check_configs.template_id IS
            ''请求模板 ID，可为空；实例配置优先级高于模板''
        ';

        IF NOT EXISTS (
            SELECT 1
            FROM pg_constraint
            WHERE conname = 'check_configs_template_id_fkey'
              AND conrelid = 'dev.check_configs'::regclass
        ) THEN
            EXECUTE '
                ALTER TABLE dev.check_configs
                ADD CONSTRAINT check_configs_template_id_fkey
                FOREIGN KEY (template_id)
                REFERENCES dev.check_request_templates(id)
                ON DELETE SET NULL
            ';
        END IF;

        EXECUTE '
            CREATE INDEX IF NOT EXISTS idx_dev_check_configs_template_id
            ON dev.check_configs (template_id)
        ';

        IF EXISTS (
            SELECT 1
            FROM pg_proc p
            JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE p.proname = 'update_updated_at_column'
              AND n.nspname = 'dev'
        ) AND NOT EXISTS (
            SELECT 1
            FROM pg_trigger
            WHERE tgname = 'update_check_request_templates_updated_at'
              AND tgrelid = 'dev.check_request_templates'::regclass
        ) THEN
            EXECUTE '
                CREATE TRIGGER update_check_request_templates_updated_at
                BEFORE UPDATE ON dev.check_request_templates
                FOR EACH ROW
                EXECUTE FUNCTION dev.update_updated_at_column()
            ';
        END IF;

        EXECUTE '
            CREATE OR REPLACE FUNCTION dev.validate_check_config_template_type()
            RETURNS trigger
            LANGUAGE plpgsql
            AS $f$
            DECLARE
                template_type dev.provider_type;
            BEGIN
                IF NEW.template_id IS NULL THEN
                    RETURN NEW;
                END IF;

                SELECT type
                INTO template_type
                FROM dev.check_request_templates
                WHERE id = NEW.template_id;

                IF template_type IS NULL THEN
                    RETURN NEW;
                END IF;

                IF template_type <> NEW.type THEN
                    RAISE EXCEPTION ''模板类型不匹配: config.type=%, template.type=%'', NEW.type, template_type;
                END IF;

                RETURN NEW;
            END;
            $f$
        ';

        IF NOT EXISTS (
            SELECT 1
            FROM pg_trigger
            WHERE tgname = 'validate_check_configs_template_type'
              AND tgrelid = 'dev.check_configs'::regclass
        ) THEN
            EXECUTE '
                CREATE TRIGGER validate_check_configs_template_type
                BEFORE INSERT OR UPDATE OF template_id, type ON dev.check_configs
                FOR EACH ROW
                EXECUTE FUNCTION dev.validate_check_config_template_type()
            ';
        END IF;
    END IF;
END;
$$;
