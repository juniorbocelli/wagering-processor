-- Executado uma única vez pelo entrypoint do Postgres, no banco POSTGRES_DB (`wagering`).
-- Cria os papéis (cluster-wide) e o banco de testes, e aplica os grants de schema nos
-- dois bancos. Ver ADR-002 §2 ("Papéis de banco").
--
--   wagering_owner : dono do schema/tabelas; usado apenas por migrations.
--   wagering_app   : runtime (API, consumer, workers); sem DDL, sem ser dono das tabelas,
--                    portanto sujeito aos REVOKE e triggers de imutabilidade.
--
-- Senhas de desenvolvimento local; em produção vêm do provisionamento (ex.: RDS/Secrets).

CREATE ROLE wagering_owner LOGIN PASSWORD 'wagering_owner';
CREATE ROLE wagering_app   LOGIN PASSWORD 'wagering_app';

CREATE DATABASE wagering_test OWNER wagering_owner;
ALTER DATABASE wagering OWNER TO wagering_owner;

-- Privilégios mínimos: a aplicação só conecta e usa o schema; os GRANTs por tabela
-- são feitos pelas migrations (owner) conforme a matriz do ADR-002.
\connect wagering
REVOKE ALL ON SCHEMA public FROM PUBLIC;
ALTER SCHEMA public OWNER TO wagering_owner;
GRANT USAGE ON SCHEMA public TO wagering_app;

\connect wagering_test
REVOKE ALL ON SCHEMA public FROM PUBLIC;
ALTER SCHEMA public OWNER TO wagering_owner;
GRANT USAGE ON SCHEMA public TO wagering_app;
