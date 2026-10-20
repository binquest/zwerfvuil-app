-- Notifications (docs/GAMIFICATION.md, chapter 5, chapter 6 and phase 7).
--
-- The notifications themselves are local: the app plans them on the phone
-- from my_game_state, so the server only learns the three events below.

insert into public.event_names (name, description) values
  ('notification_permission', 'The app asked for notifications: its own explanation (pre) or the system prompt (system).'),
  ('notification_scheduled', 'A local notification was planned (a new one, not one planned before).'),
  ('notification_opened', 'A local notification was tapped and opened the app.');

notify pgrst, 'reload schema';
