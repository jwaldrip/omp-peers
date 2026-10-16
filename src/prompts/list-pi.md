List other active or offline OMP sessions on this machine.

Call list_pi first when the target session is not explicit. Never guess a session name or role name.
Returns a list of sessions formatted as Name [ref] with status, working directory, git branch, and full session ID.
Use the returned Name [ref] or full session ID as the target parameter in send_pi_message.
