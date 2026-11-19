-- Vault schema v1.1
-- Rule: nothing is ever deleted or edited in place.
--   active = 1  -> current version (default)
--   active = 0  -> old / retired version
-- "Update" = set old row active = 0, insert a new row with active = 1 and replaces_id = old row_id.
-- "Forget" = set active = 0 (no new row).
-- Every table has an integer row_id (one per version) and, where needed, a stable logical id
-- that stays the same across versions. Only one ACTIVE row may exist per logical id.

-- 1. Profile
CREATE TABLE profile (
  row_id      INTEGER PRIMARY KEY AUTOINCREMENT,
  section     TEXT NOT NULL,            -- about / work / preferences / current_focus
  content     TEXT NOT NULL,
  source      TEXT,
  active      INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  replaces_id INTEGER,                  -- row_id of the version this one replaced
  created     TEXT NOT NULL,            -- when this version was written
  deactivated TEXT                      -- when it was set to 0
);
CREATE UNIQUE INDEX profile_one_active ON profile(section) WHERE active = 1;

-- 2. Projects
CREATE TABLE projects (
  row_id       INTEGER PRIMARY KEY AUTOINCREMENT,
  id           TEXT NOT NULL,           -- stable slug, e.g. "memory-server"
  name         TEXT NOT NULL,
  description  TEXT,
  instructions TEXT,
  status       TEXT NOT NULL DEFAULT 'active',   -- active / paused / done (work status, separate from row active)
  source       TEXT,                    -- app that wrote this version
  active       INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  replaces_id  INTEGER,
  created      TEXT NOT NULL,
  deactivated  TEXT
);
CREATE UNIQUE INDEX projects_one_active ON projects(id) WHERE active = 1;

-- 3. Facts
CREATE TABLE facts (
  row_id       INTEGER PRIMARY KEY AUTOINCREMENT,
  fact         TEXT NOT NULL,
  category     TEXT NOT NULL,           -- identity / work / goals / plans / preferences / people / projects / skills / other
  kind         TEXT NOT NULL DEFAULT 'lasting',  -- lasting / temporary
  project_id   TEXT,                    -- logical project id
  source       TEXT,
  active       INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  replaces_id  INTEGER,
  created      TEXT NOT NULL,
  expires      TEXT,                    -- temporary facts only
  deactivated  TEXT
);
CREATE INDEX facts_active ON facts(active, category, created);
CREATE INDEX facts_project ON facts(project_id, active);

-- 4. Conversations
CREATE TABLE conversations (
  row_id       INTEGER PRIMARY KEY AUTOINCREMENT,
  id           TEXT NOT NULL,           -- stable id, "<source>:<original id>" or "vault:<uuid>"
  title        TEXT,
  source       TEXT NOT NULL,
  project_id   TEXT,
  created      TEXT,                    -- when the chat happened
  saved        TEXT NOT NULL,           -- when this version entered Vault
  active       INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  replaces_id  INTEGER,
  deactivated  TEXT
);
CREATE UNIQUE INDEX conv_one_active ON conversations(id) WHERE active = 1;
CREATE INDEX conv_project ON conversations(project_id, active);
CREATE INDEX conv_source_date ON conversations(source, created);

-- 5. Messages
CREATE TABLE messages (
  row_id          INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL,        -- logical conversation id
  seq             INTEGER NOT NULL,
  role            TEXT NOT NULL,        -- you / ai
  time            TEXT,
  text            TEXT NOT NULL,
  source          TEXT,
  active          INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  replaces_id     INTEGER,
  created         TEXT NOT NULL,
  deactivated     TEXT
);
CREATE INDEX msg_conv ON messages(conversation_id, seq, active);

-- 6. Documents
CREATE TABLE documents (
  row_id          INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_id          TEXT NOT NULL,        -- stable id across versions, e.g. "doc:<uuid>"
  name            TEXT NOT NULL,
  file_type       TEXT,
  scope           TEXT NOT NULL CHECK (scope IN ('project','conversation','standalone')),
  content         TEXT NOT NULL,
  project_id      TEXT,
  conversation_id TEXT,
  source          TEXT,
  active          INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  replaces_id     INTEGER,
  created         TEXT NOT NULL,
  deactivated     TEXT
);
CREATE UNIQUE INDEX docs_one_active ON documents(doc_id) WHERE active = 1;
CREATE INDEX docs_project ON documents(project_id, scope, active);
CREATE INDEX docs_conv ON documents(conversation_id, active);

-- 7. Memory notes
CREATE TABLE memory_notes (
  row_id      INTEGER PRIMARY KEY AUTOINCREMENT,
  path        TEXT NOT NULL,
  content     TEXT NOT NULL,
  project_id  TEXT,
  source      TEXT NOT NULL,
  active      INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  replaces_id INTEGER,
  created     TEXT NOT NULL,
  deactivated TEXT
);
CREATE UNIQUE INDEX notes_one_active ON memory_notes(source, path, IFNULL(project_id,'')) WHERE active = 1;

-- 8. Clients (connected apps)
CREATE TABLE clients (
  row_id      INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id   TEXT NOT NULL,
  source      TEXT NOT NULL,
  label       TEXT,
  active      INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),  -- 0 = revoked
  replaces_id INTEGER,
  created     TEXT NOT NULL,
  last_used   TEXT,
  deactivated TEXT
);
CREATE UNIQUE INDEX clients_one_active ON clients(client_id) WHERE active = 1;

-- 9. Full-text search (rows are only ever inserted, so insert triggers are enough;
--    queries join back to the table and filter active = 1)
CREATE VIRTUAL TABLE messages_fts  USING fts5(text, content='messages', content_rowid='row_id');
CREATE VIRTUAL TABLE documents_fts USING fts5(name, content, content='documents', content_rowid='row_id');
CREATE VIRTUAL TABLE facts_fts     USING fts5(fact, content='facts', content_rowid='row_id');

CREATE TRIGGER messages_ai  AFTER INSERT ON messages  BEGIN
  INSERT INTO messages_fts(rowid, text) VALUES (new.row_id, new.text); END;
CREATE TRIGGER documents_ai AFTER INSERT ON documents BEGIN
  INSERT INTO documents_fts(rowid, name, content) VALUES (new.row_id, new.name, new.content); END;
CREATE TRIGGER facts_ai     AFTER INSERT ON facts     BEGIN
  INSERT INTO facts_fts(rowid, fact) VALUES (new.row_id, new.fact); END;

-- 10. Safety: block hard deletes and in-place content edits at the database level
CREATE TRIGGER no_delete_facts     BEFORE DELETE ON facts         BEGIN SELECT RAISE(ABORT, 'Vault never deletes: set active = 0'); END;
CREATE TRIGGER no_delete_messages  BEFORE DELETE ON messages      BEGIN SELECT RAISE(ABORT, 'Vault never deletes: set active = 0'); END;
CREATE TRIGGER no_delete_docs      BEFORE DELETE ON documents     BEGIN SELECT RAISE(ABORT, 'Vault never deletes: set active = 0'); END;
CREATE TRIGGER no_delete_conv      BEFORE DELETE ON conversations BEGIN SELECT RAISE(ABORT, 'Vault never deletes: set active = 0'); END;
CREATE TRIGGER no_delete_projects  BEFORE DELETE ON projects      BEGIN SELECT RAISE(ABORT, 'Vault never deletes: set active = 0'); END;
CREATE TRIGGER no_delete_profile   BEFORE DELETE ON profile       BEGIN SELECT RAISE(ABORT, 'Vault never deletes: set active = 0'); END;
CREATE TRIGGER no_delete_notes     BEFORE DELETE ON memory_notes  BEGIN SELECT RAISE(ABORT, 'Vault never deletes: set active = 0'); END;
CREATE TRIGGER no_edit_facts BEFORE UPDATE OF fact, category, kind, project_id, expires ON facts
  BEGIN SELECT RAISE(ABORT, 'Vault never edits in place: deactivate and insert a new version'); END;
CREATE TRIGGER no_edit_messages BEFORE UPDATE OF text, role, seq, conversation_id ON messages
  BEGIN SELECT RAISE(ABORT, 'Vault never edits in place: deactivate and insert a new version'); END;
CREATE TRIGGER no_edit_docs BEFORE UPDATE OF content, name, scope, project_id, conversation_id ON documents
  BEGIN SELECT RAISE(ABORT, 'Vault never edits in place: deactivate and insert a new version'); END;
CREATE TRIGGER no_edit_profile BEFORE UPDATE OF content, section ON profile
  BEGIN SELECT RAISE(ABORT, 'Vault never edits in place: deactivate and insert a new version'); END;
CREATE TRIGGER no_edit_projects BEFORE UPDATE OF name, description, instructions, status ON projects
  BEGIN SELECT RAISE(ABORT, 'Vault never edits in place: deactivate and insert a new version'); END;
CREATE TRIGGER no_edit_notes BEFORE UPDATE OF content, path ON memory_notes
  BEGIN SELECT RAISE(ABORT, 'Vault never edits in place: deactivate and insert a new version'); END;
CREATE TRIGGER no_edit_conv BEFORE UPDATE OF title, project_id, source ON conversations
  BEGIN SELECT RAISE(ABORT, 'Vault never edits in place: deactivate and insert a new version'); END;
