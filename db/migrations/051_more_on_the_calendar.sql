-- 051 more on the calendar: timeline milestones and your shifts show on the Calendar (beside tasks due,
-- bookings and time off), and which of these the Calendar shows is remembered per person.
--   * Nothing new to read: the Calendar reads weft.milestones and weft.shifts / weft.shift_signups through
--     their own policies (047, 032), as the person, so only members of a channel see its milestones and
--     shifts, in the browser and live. "Your shifts" is the person's own sign-ups.
--   * The one new piece of data is the person's choice of entries, in their own weft.user_prefs row (019):
--     a calendar column, {"off": ["tasks", "milestones", "shifts", "bookings", "away"]} listing what is
--     switched off. user_prefs is per person, not per space: only its owner reads or writes it, never with
--     a channel-scoped token, and the assistant role has no grant on it. The shape is checked here so the
--     column cannot be used to store anything else.
set client_min_messages = warning;

alter table weft.user_prefs add column if not exists calendar jsonb not null default '{}'::jsonb;

alter table weft.user_prefs drop constraint if exists user_prefs_calendar_shape;
alter table weft.user_prefs add constraint user_prefs_calendar_shape check (
  jsonb_typeof(calendar) = 'object'
  and calendar - 'off' = '{}'::jsonb
  and (not calendar ? 'off' or (
    jsonb_typeof(calendar -> 'off') = 'array'
    and jsonb_array_length(calendar -> 'off') <= 5
    and (calendar -> 'off') <@ '["tasks", "milestones", "shifts", "bookings", "away"]'::jsonb
  ))
);

-- Only the column itself; user_id defaults to the caller and is never granted (the policy checks it too).
grant insert (calendar), update (calendar) on weft.user_prefs to weft_user;
