"""The Aurora T3 Pro support-article corpus. Given data, seeded into
Postgres automatically at startup (see db.py) -- your job is fusion.py, not
this file.

28 short support articles for a fictional smart thermostat, covering about
14 topics. The corpus (and the queries used to grade it) is built on
purpose so that:

  - some queries are answered by a document that shares almost no words
    with the query at all -- only (pseudo-)vector search finds it;
  - some queries name an exact, distinctive term (an error code) where two
    documents are otherwise about the same general topic -- only keyword
    search tells them apart, because the pseudo-embedding never learned
    that exact codes matter;
  - some queries are a strong match on both signals for the same document
    -- a fusion that doesn't deduplicate will show it twice;
  - some queries have a "technically mentions it" document that pulls
    ahead on raw (pseudo-)vector similarity while a document with the
    literal term the user typed sits behind it in keyword rank alone --
    exposing what happens when two differently-scaled raw numbers are
    just added together.
"""

DOCUMENTS = [
    # --- short_cycle: exactly one doc, phrased in engineer-speak so a
    # symptom-phrased query shares almost no literal words with it. ---
    ("sc-1", "The Aurora T3 Pro will short-cycle if the temperature "
             "differential is set too small; widen the swing value under "
             "Settings > Advanced > Temperature Differential to stop the "
             "rapid on, off, on, off behavior and let the system run a full "
             "cycle before it shuts off again."),

    # decoy for the short-cycle vector-only query: shares literal words
    # ("warm", "room") with that query but is really about humidity, not
    # cycling.
    ("hum-1", "Warm, humid air trapped in a closed room can condense on the "
              "Aurora T3 Pro's display and cause a temporary blank screen; "
              "run the dehumidify mode for an hour and check for a musty "
              "smell near the vents, a sign of mold in the ductwork."),

    # --- sensor_fault: two docs, same generic concept, distinguished only
    # by an exact, non-embedded error code. ---
    ("e47-1", "Error E-47 means the ambient sensor is misreading room "
              "temperature. Remove the faceplate, unplug and reseat the "
              "ambient sensor ribbon cable, then recalibrate from Settings > "
              "Diagnostics > Sensor Recalibration."),
    ("e52-1", "Error E-52 means the return-air sensor in the air handler is "
              "giving a faulty reading. Check the sensor's connector at the "
              "air handler, reseat it firmly, then recalibrate from "
              "Settings > Diagnostics > Sensor Recalibration."),

    # --- filter_clog ---
    ("filt-1", "Weak airflow from every vent, room by room, usually means a "
               "clogged filter. Replace the filter every 60-90 days; a "
               "filter caked with dust buildup is the single most common "
               "cause of reduced airflow complaints."),
    ("filt-2", "If the Aurora T3 Pro reports 'Airflow Low' on its home "
               "screen, check the filter before anything else -- a filter "
               "blocking more than half its surface with dust will trigger "
               "this warning even though every duct and vent is fine."),
    ("filt-3", "A filter that looks clean can still restrict airflow if it "
               "was installed backwards -- check the arrow printed on the "
               "frame points toward the air handler, not away from it."),

    # --- wifi_pairing ---
    ("wifi-1", "If the app can't find the device during setup, hold the "
               "Aurora T3 Pro's front button for 10 seconds to enter wifi "
               "setup mode, then join the network named AuroraSetup-XXXX "
               "from your phone's own wifi settings before opening the app "
               "again."),
    ("wifi-2", "Pairing fails on 5GHz-only networks -- the Aurora T3 Pro "
               "only joins 2.4GHz wifi. Create a separate 2.4GHz network "
               "name on your router, or enable band steering, before "
               "retrying setup."),
    ("wifi-3", "If setup mode times out before you finish joining "
               "AuroraSetup-XXXX, hold the front button for 10 seconds "
               "again to re-enter it; it does not require a factory reset."),

    # --- firmware_update ---
    ("fw-1", "A firmware update stuck at the same percentage for more than "
             "20 minutes has failed silently. Hold the front button for 15 "
             "seconds to reboot, then retry the update from Settings > "
             "System > Software Update; do not unplug power mid-update."),
    ("fw-2", "Firmware updates are staged gradually across devices and a "
             "specific unit may not see one for several days after release; "
             "this is expected and not a sign anything failed."),

    # --- battery_backup ---
    ("batt-1", "After a power outage, the Aurora T3 Pro runs on its backup "
               "battery for up to 6 hours but loses its wifi connection and "
               "schedule sync until wall power returns; the clock is kept "
               "by the backup battery so it will not reset the time."),

    # --- humidity_control (second doc, distinct from hum-1) ---
    ("hum-2", "A persistent musty smell even with dehumidify mode on for "
              "days usually points to mold already growing in the ductwork, "
              "not a setting -- the Aurora T3 Pro can only manage humidity "
              "going forward, it cannot remediate existing mold."),

    # --- geofencing ---
    ("geo-1", "Away mode based on your phone's location needs Precise "
              "Location permission granted to the Aurora app; with only "
              "Approximate Location allowed, geofencing will trigger late "
              "or not at all when you arrive home."),
    ("geo-2", "Geofencing radius defaults to 500 meters and can be widened "
              "under Settings > Locations > Geofence Radius if away mode "
              "triggers while you're still nearby, like at a neighbor's "
              "driveway."),

    # --- multi_zone ---
    ("zone-1", "When the upstairs and downstairs zones disagree on mode "
               "(one heating, one cooling), check the zone controller's own "
               "priority setting -- by default the zone with the most "
               "recent manual change wins until the next scheduled event."),
    ("zone-2", "Adding a third zone requires a compatible zone controller "
               "hub sold separately -- the Aurora T3 Pro's built-in "
               "two-zone support cannot be expanded by software alone."),

    # --- voice_assistant ---
    ("voice-1", "To ask Alexa to change the temperature, the Aurora skill "
                "must be linked in the Alexa app first; 'Alexa, set the "
                "thermostat to 70' will otherwise answer that it doesn't "
                "recognize that device."),
    ("voice-2", "Google Home commands referencing a room name only work if "
                "that room name matches exactly what's set in the Google "
                "Home app, not the name set in the Aurora app."),

    # --- api_rate_limit: the keyword-vs-dominance target. Contains the
    # rare, distinctive term "429" so ts_rank is high for a query naming
    # it, and only loosely touches any other concept. ---
    ("api-1", "The Aurora developer API returns HTTP 429 with a "
              "quota_exceeded body when a client polls the /status endpoint "
              "more often than once every 30 seconds per device; back off "
              "and retry with exponential delay rather than polling on a "
              "fixed short interval, and cache /status between calls."),
    ("api-2", "Authentication tokens for the developer API expire after 24 "
              "hours; a client that caches a token past expiry starts "
              "seeing authentication failures -- refresh the token rather "
              "than retrying the same request unchanged."),

    # --- schedule_sync: the dominance decoy. Genuinely touches BOTH
    # `schedule_sync` and `api_rate_limit` -- via *different* wording than
    # the dominance query uses for each -- so it (pseudo-)embeds as a
    # near-perfect vector match to that two-concept query, while sharing
    # no literal, distinctive token with it at all. ---
    ("sched-1", "If the schedule shown in the app doesn't match the device, "
                "the two are out of sync -- this can happen on a poor "
                "connection and misses an update. A client that checks in "
                "this aggressively may also start seeing too many requests "
                "refused by the developer API until it backs off; force a "
                "resync from Settings > Schedule > Resync Now to sync the "
                "schedule again rather than checking in this aggressively."),

    # --- installation_wiring ---
    ("wire-1", "A screen that stays black and never powers on, even after "
               "holding the front button, usually means no C-wire is "
               "connected -- check the wiring at the wall plate against the "
               "included wiring diagram before assuming the unit itself is "
               "defective."),
    ("wire-2", "A blank screen that flickers briefly on button press but "
               "won't stay on points to an underpowered C-wire adapter, not "
               "missing wiring -- swap in the included adapter rather than a "
               "generic one."),

    # --- energy_reports ---
    ("energy-1", "The monthly usage report undercounts runtime for any day "
                 "the device was offline (wifi down, power outage) -- it "
                 "reports only the hours it could actually log, and does "
                 "not estimate or interpolate the missing hours."),
    ("energy-2", "Comparing this month's report to last month is only "
                 "meaningful if the billing period lengths match -- feed the "
                 "report's own period_days field into any month-over-month "
                 "comparison rather than assuming every month is equal."),
]
