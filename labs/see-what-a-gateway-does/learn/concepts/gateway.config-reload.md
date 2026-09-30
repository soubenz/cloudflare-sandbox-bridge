---
id: gateway.config-reload
title: Changing gateway config and reloading it
minutes: 2
recap: The gateway reads its config when it starts, so an edit changes nothing until the service restarts; verify the change with a call, not by rereading the file.
---
The alias mapping is a file, and this gateway reads that file when it starts. Editing `gateway/config.yaml` on disk does nothing to the running process. The change takes effect only when `litellm` restarts and reads the file again.

That has a few practical consequences.

There is a gap between saving and taking effect. If you save a file and then test immediately, you are testing the old config. When a change seems to have done nothing, the first thing to suspect is that nothing has reloaded it yet.

Restarting has a cost. The gateway needs about half a minute to come back, and calls during that time will fail. In production you do not restart a shared gateway casually. Teams use rolling restarts, or a gateway that can reload config live. Knowing which one you have is part of knowing your gateway.

Only what you edited changes. Other aliases keep their mapping, and the records behind them survive. The spend log lives in Postgres, a separate service, so a gateway restart does not clear it. The provider keeps its own log as its own process, which a restart of the gateway does not touch either.

Finally, verify by behaviour. A saved file proves you wrote the file. Only a call proves what the gateway now does. The evidence is on the provider side: send a call to the alias you changed and see which deployment recorded it.

In the lab, the ungraded exercise has you change what `fast` means, restart `litellm` from the **Services** panel, and send `fast` a call again. Watch the **view** tab after the restart. The graded questions are about `support` and about an alias that is not in the config, so this exercise cannot break them.
