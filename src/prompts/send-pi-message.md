Send a message to another OMP session on this machine.

Call list_pi first when the target is not explicit. Never guess a session name or role name.
Target sessions using exact Name [ref] or full session ID obtained from list_pi.

Send concrete findings, decisions, questions, or status another session needs. Do not send routine progress updates.
Delivery is durable and handled automatically by the extension:
- If the recipient is idle, delivery wakes the recipient and starts a turn.
- If the recipient is currently running, the message is injected at the next step boundary.
- If the recipient is offline, the message is queued and delivered when resumed.
Never retry or poll: delivery is the extension's responsibility.
When the recipient responds, the reply arrives as an incoming peer-message in this session.
