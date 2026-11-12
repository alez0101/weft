-- 013: whiteboards are items too (kind 'whiteboard'), so they share spaces, permissions, sharing, moving,
-- deleting and the audit trail with documents. Their live state is a Yjs map of Excalidraw elements
-- (one entry per element id), co-edited through the collab server; text on the board is extracted to
-- body_text for search and the assistant.
set client_min_messages = warning;
alter table weft.items drop constraint if exists items_kind_check;
alter table weft.items add constraint items_kind_check check (kind in ('document', 'wiki', 'whiteboard'));
