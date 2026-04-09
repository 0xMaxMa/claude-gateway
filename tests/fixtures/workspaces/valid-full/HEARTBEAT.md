tasks:
  - name: morning-brief
    cron: "0 8 * * *"
    prompt: "Give a brief morning summary."

# Behaviour
- If nothing needs attention, reply HEARTBEAT_OK.
