-- Vault schema v1.3: embeddings (meaning search)
-- The vectors themselves live in Cloudflare Vectorize (index "vault-embeddings", one namespace per
-- item type). This table records which piece of which item is in that index, so updates and forgets
-- can take the right vectors out, and the whole index can be rebuilt from D1 at any time.
-- Same rules as before: nothing is deleted or edited in place; rows are retired (active = 0).

CREATE TABLE embeddings (
  row_id      INTEGER PRIMARY KEY AUTOINCREMENT,
  item_type   TEXT NOT NULL CHECK (item_type IN ('fact','conversation','document','project','profile')),
  item_id     TEXT NOT NULL,            -- fact row_id / conversation id / doc_id / project id / profile section
  part        INTEGER NOT NULL,         -- 0, 1, 2… for items split into pieces
  vector_id   TEXT NOT NULL,            -- id in Vectorize (hash of type, id, part; under 64 bytes)
  seq_from    INTEGER,                  -- chats: first and last message seq in this piece
  seq_to      INTEGER,
  char_from   INTEGER,                  -- documents: where this piece starts and ends in the text
  char_to     INTEGER,
  model       TEXT NOT NULL,            -- embedding model, e.g. @cf/baai/bge-m3
  active      INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created     TEXT NOT NULL,
  deactivated TEXT
);
CREATE UNIQUE INDEX embeddings_one_active ON embeddings(vector_id) WHERE active = 1;
CREATE INDEX embeddings_item ON embeddings(item_type, item_id, active);

CREATE TRIGGER no_delete_embeddings BEFORE DELETE ON embeddings
  BEGIN SELECT RAISE(ABORT, 'Vault never deletes: set active = 0'); END;
CREATE TRIGGER no_edit_embeddings BEFORE UPDATE OF item_type, item_id, part, vector_id, seq_from, seq_to, char_from, char_to, model ON embeddings
  BEGIN SELECT RAISE(ABORT, 'Vault never edits rows in place: retire and insert'); END;
