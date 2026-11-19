-- Vault schema v1.2: knowledge graph
-- Same rules as 0001: nothing is deleted or edited in place. Links are retired (active = 0) and
-- new rows inserted. Only Vault's own code writes these tables; no MCP tool can write them.

-- 1. Entities: people, places, projects, things… one active row per stable id
CREATE TABLE entities (
  row_id      INTEGER PRIMARY KEY AUTOINCREMENT,
  id          TEXT NOT NULL,            -- stable id, e.g. "person:priya"
  name        TEXT NOT NULL,            -- display name
  type        TEXT NOT NULL CHECK (type IN ('person','project','organisation','place','thing','goal','event','topic')),
  summary     TEXT,                     -- optional one-line description
  source      TEXT,                     -- what wrote it: graph_backfill / graph_auto
  active      INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  replaces_id INTEGER,
  created     TEXT NOT NULL,
  deactivated TEXT
);
CREATE UNIQUE INDEX entities_one_active ON entities(id) WHERE active = 1;

-- 2. Every name an entity is known by ("priya", "my sister"), normalised for fast lookup
CREATE TABLE entity_names (
  row_id      INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_id   TEXT NOT NULL,
  name_key    TEXT NOT NULL,            -- lower case, punctuation removed
  active      INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created     TEXT NOT NULL,
  deactivated TEXT
);
CREATE UNIQUE INDEX entity_names_one_active ON entity_names(entity_id, name_key) WHERE active = 1;
CREATE INDEX entity_names_key ON entity_names(name_key, active);

-- 3. Relations: "from → relation → to" (another entity) or "from → relation → value" (a detail)
CREATE TABLE relations (
  row_id      INTEGER PRIMARY KEY AUTOINCREMENT,
  from_id     TEXT NOT NULL,            -- entity id
  relation    TEXT NOT NULL,            -- fixed list in src/graph/schema.ts
  to_id       TEXT,                     -- entity id, or NULL when the link is a detail
  value       TEXT,                     -- detail, e.g. "sister", "1TB", "Feb 2027"
  origin_type TEXT NOT NULL CHECK (origin_type IN ('fact','conversation','document','project','profile')),
  origin_id   TEXT NOT NULL,            -- fact row_id / conversation id / doc_id / project id / profile section
  valid_from  TEXT,
  source      TEXT,
  active      INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  replaces_id INTEGER,
  created     TEXT NOT NULL,
  deactivated TEXT,
  CHECK (to_id IS NOT NULL OR value IS NOT NULL)
);
CREATE INDEX relations_from   ON relations(from_id, relation, active);
CREATE INDEX relations_to     ON relations(to_id, active);
CREATE INDEX relations_origin ON relations(origin_type, origin_id, active);

-- 4. Append-only log: which item was processed, by which step, and how it went
CREATE TABLE graph_log (
  row_id      INTEGER PRIMARY KEY AUTOINCREMENT,
  item_type   TEXT NOT NULL,            -- fact / conversation / document / project / profile
  item_id     TEXT NOT NULL,
  step        TEXT NOT NULL,            -- extract / write / review
  status      TEXT NOT NULL CHECK (status IN ('ok','failed','skipped','review')),
  detail      TEXT,                     -- counts or error text; never personal content
  created     TEXT NOT NULL
);
CREATE INDEX graph_log_item ON graph_log(item_type, item_id, step);

-- 5. The owner of the Vault: every "I / me" in the data links here
INSERT INTO entities (id, name, type, summary, source, created)
  VALUES ('person:me', 'Me', 'person', 'The owner of this Vault', 'migration', strftime('%Y-%m-%dT%H:%M:%fZ','now'));
INSERT INTO entity_names (entity_id, name_key, created) VALUES
  ('person:me', 'me',     strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('person:me', 'myself', strftime('%Y-%m-%dT%H:%M:%fZ','now'));

-- 6. Keep the graph in step with facts automatically: when a fact is replaced or forgotten,
--    the links taken from it are retired too (the new fact's links are added by Vault's code)
CREATE TRIGGER facts_retire_links AFTER UPDATE OF active ON facts
  WHEN OLD.active = 1 AND NEW.active = 0
  BEGIN
    UPDATE relations SET active = 0, deactivated = NEW.deactivated
     WHERE origin_type = 'fact' AND origin_id = CAST(OLD.row_id AS TEXT) AND active = 1;
  END;

-- 7. Safety, same as 0001: no deletes, no in-place edits
CREATE TRIGGER no_delete_entities     BEFORE DELETE ON entities     BEGIN SELECT RAISE(ABORT, 'Vault never deletes: set active = 0'); END;
CREATE TRIGGER no_delete_entity_names BEFORE DELETE ON entity_names BEGIN SELECT RAISE(ABORT, 'Vault never deletes: set active = 0'); END;
CREATE TRIGGER no_delete_relations    BEFORE DELETE ON relations    BEGIN SELECT RAISE(ABORT, 'Vault never deletes: set active = 0'); END;
CREATE TRIGGER no_delete_graph_log    BEFORE DELETE ON graph_log    BEGIN SELECT RAISE(ABORT, 'Vault never deletes: set active = 0'); END;
CREATE TRIGGER no_edit_entities BEFORE UPDATE OF id, name, type, summary ON entities
  BEGIN SELECT RAISE(ABORT, 'Vault never edits in place: deactivate and insert a new version'); END;
CREATE TRIGGER no_edit_entity_names BEFORE UPDATE OF entity_id, name_key ON entity_names
  BEGIN SELECT RAISE(ABORT, 'Vault never edits in place: deactivate and insert a new version'); END;
CREATE TRIGGER no_edit_relations BEFORE UPDATE OF from_id, relation, to_id, value, origin_type, origin_id ON relations
  BEGIN SELECT RAISE(ABORT, 'Vault never edits in place: deactivate and insert a new version'); END;
CREATE TRIGGER no_edit_graph_log BEFORE UPDATE ON graph_log
  BEGIN SELECT RAISE(ABORT, 'graph_log is append-only'); END;
