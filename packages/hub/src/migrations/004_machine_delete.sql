-- Deleted machines are kept (soft delete) so job history still names them; deleted_at hides them everywhere else.
ALTER TABLE machines ADD COLUMN deleted_at INTEGER;

-- A saved `github:<x>` identifier is valid only while the user's login is x (case-insensitive). Earlier hubs cleared a
-- stale login without removing it; drop every such entry. Other identifiers (github-id:, email:, sub:) are kept.
UPDATE users SET identifiers = (
  SELECT json_group_array(value) FROM json_each(users.identifiers)
  WHERE NOT (typeof(value) = 'text' AND lower(value) LIKE 'github:%'
             AND (users.login = '' OR substr(lower(value), 8) != lower(users.login)))
)
WHERE identifiers IS NOT NULL AND json_valid(identifiers) AND EXISTS (
  SELECT 1 FROM json_each(users.identifiers)
  WHERE typeof(value) = 'text' AND lower(value) LIKE 'github:%'
        AND (users.login = '' OR substr(lower(value), 8) != lower(users.login))
);
