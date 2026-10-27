-- F1 live timing (livetiming.formula1.com), accessed with each user's own Formula 1 account.
-- Since 2025 the archive and the live SignalR feed require an F1 TV subscription token
-- (verified: unauthenticated requests to /static/... return 401). Data fetched with a user's
-- token is private to that user's tenant: ingestion refuses public visibility for this source,
-- and it is never shown to anonymous viewers.
INSERT INTO data_sources (id, name, api_version, homepage, license, permitted_use, redistribution, attribution, update_frequency, historical_coverage, accuracy_notes, missing_channels, rate_limit, retention, public_display_allowed, enabled) VALUES
  ('f1lt', 'F1 Live Timing (your Formula 1 account)', 'static + signalrcore', 'https://www.formula1.com',
   'Formula 1 data accessed with the user''s own F1 TV subscription token. Subject to the Formula 1 terms of use; no redistribution rights are granted by a subscription.',
   'Personal analysis by the subscribed user, inside their own tenant only.',
   'forbidden',
   'Data: Formula 1 live timing. F1, FORMULA ONE and related marks are trademarks of Formula One Licensing B.V.',
   'Live during sessions; archive shortly after each session', '2018 onwards',
   'Same feed FastF1 reads. car data ~3.7 Hz, position ~4 Hz in 1/10 m; speed quantised to 1 km/h; brake binary.',
   ARRAY['brake_pressure', 'steering', 'tyre_temperature', 'tyre_pressure', 'fuel', 'ers_state', 'active_aero_state', 'overtake_mode_state'],
   'Conservative 2 requests/s per tenant', 'Stored per tenant; deleted with the tenant',
   false, true)
ON CONFLICT (id) DO NOTHING;
