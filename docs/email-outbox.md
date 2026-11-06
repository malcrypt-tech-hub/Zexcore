# Email outbox

Important emails are written to Firestore (`emailOutbox/{id}`, Worker-only) before they are sent, so a provider outage or a Worker crash does not lose them.

* **Retries:** after a failure the message waits 1 min, 5 min, 30 min, 2 h, 12 h, then is marked `dead` after 6 tries. A permanent rejection (bad address, 4xx) goes `dead` straight away. The hourly cron (`scheduled`) does the retrying, so a retry can be up to an hour late.
* **No provider yet:** with no `RESEND_API_KEY` the message waits an hour at a time without using up tries, and is sent once the key is set.
* **Crash recovery:** a sender takes a message with a 5-minute lease. If it dies, the next run takes the message over once the lease has run out.
* **No duplicates:** the record id comes from a key such as `ack:<workspace>:<booking>`, so asking twice queues once. The same id goes to Resend as an `Idempotency-Key`, so a retry after a crash that happened after Resend accepted the message is dropped by Resend (it remembers keys for about a day).
* **Privacy:** after sending (or giving up) the subject and body are erased. Sent records are deleted after 7 days, dead ones after 30.

Moved onto the outbox: booking acknowledgement and owner alert, reschedule notice, deposit receipt, waitlist offers, released-deposit notice, new-device sign-in, and order request, owner alert and status emails.
Not on it (sent directly, result shown at once): welcome, team invitations, weekly digest, deposit-link emails, IoT alerts, account deletion notice.

To see what is stuck: Firestore console, `emailOutbox`, filter `status` = `dead` or `pending` (`lastError` says why).

## Customer emails around an appointment

Sent by the hourly job through the outbox, only for workspaces whose owner switched them on under Settings, "Emails to your customers":

* **Reminder** (`settings.reminderEmails`): about a day before a *confirmed* appointment, only when the booking was made more than 26 hours ahead. New workspaces get it switched on at the end of setup; existing ones start off.
* **Thank-you** (`settings.followUpEmails`, off by default): a day after a booking is marked completed, with a link to book again.

Both need the customer's email address (optional on the booking page). Keys are `remind:<ws>:<booking>` and `followup:<ws>:<booking>`, so no one is emailed twice.
