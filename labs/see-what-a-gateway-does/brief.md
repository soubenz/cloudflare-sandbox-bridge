# See what a gateway actually does

You have a small gateway running, the same idea as in the warm-up. An app
asks for a name such as `support`, and the gateway decides which model
answers, adds the key, and writes the call in its log. The two models here
are pretend ones, **a** and **b**, so nothing costs money.

## What you have

- **Terminal**: send calls with `send_calls.py`.
- **view** tab: two records side by side: what the model received, and what
  the gateway wrote in its log.
- **Questions** tab: three questions you answer from what you see.

## 1. Send your first calls

Press **Run**:

```bash
python3 -B send_calls.py support "hello gateway"
python3 -B send_calls.py fast "hello gateway"
```

Each call shows whether it worked, which model answered, and how many
tokens it used. Find the same calls in the **view** tab.

## 2. Answer the questions

Each question in the **Questions** tab tells you what to try.

## 3. Press Check

Check makes sure the gateway is still running, then compares your answers
with what it does right now.

## Extra, not graded: change the table

`gateway/config.yaml` is the gateway's table: each name points at a model.
Point `fast` at the model `support` uses and save. Restart `litellm` from
the **Services** panel (about 30 seconds), then send `fast` a call again.
