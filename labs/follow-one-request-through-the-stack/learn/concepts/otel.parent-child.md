---
id: otel.parent-child
title: Parent and child spans across services
minutes: 3
order: 3
recap: Every span except the root names a parent; nesting in the waterfall shows which span was running when another started, even across services.
---
Now that you can read one span, look at how spans connect. Each span except the first records a **parent span id**. The first span, the one with no parent, is the **root**. Follow the parent ids and you get a tree, and the waterfall is that tree drawn with indentation.

::diagram[otel-parent-child]

The tree says more than the timing does. Two children of the same parent that run one after another, like `auth.verify_session` and the model call under the gateway's request span, are **siblings**: the parent did one thing, then another. A child nested under a child is different. It means one span was already running when another began, and that inner span is part of the outer span's work. The direct parent is the row it sits immediately under, not the top of the tree. If you were reading a trace where `render_page` called `load_template`, which read a file, the file read's parent would be `load_template`, and only its grandparent would be `render_page`.

This still holds when spans come from different services. The sender needs to know its parent at the moment it starts, and across a network hop that is what the W3C `traceparent` header carries: the trace id and the id of the calling span. The receiving service starts its own span with that as the parent, and the tree stays whole. Without it you get separate traces and no way to connect them.

In this lab the seed script does the same thing inside one process by handing each span its parent's context. Spans from four different services end up in one tree, so a service boundary can appear between a parent and its child.

To answer a "direct parent" question, expand the row and look at the indentation of the span in question. Then find the row above it at one level less indent. That row is the parent. Everything above that is an ancestor, not a parent.
