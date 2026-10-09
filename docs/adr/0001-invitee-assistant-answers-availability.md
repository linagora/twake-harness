# The invitee's assistant answers for the invitee's calendar

When a listened conversation asks to meet, the organizer's assistant does not read the invitee's free/busy in Calendar. It sends the invitee's assistant an availability request (a period, the asked time, a duration and who asks), which is answered from the invitee's own personal calendar, under their availability sharing, with candidate slots and nothing else. We chose this because the owner's assistant should be the only reader of its owner's calendar: only the owner's token reads their working hours in Calendar, a user's token reading another user's free/busy is unconfirmed (twake-space-agent-contracts#37), and the consent the invitee gave in Twake Chat says nothing about their calendar. Within one organization, the exchange stays inside the harness, and no model reads words written by another person or assistant.

## Considered Options

- **Read the invitee's free/busy directly** with `find_meeting_slots`, as suggestions did first. Rejected: the organizer's side reads a calendar whose owner had no say, and it would rely on #37.
- **A conversation between the two assistants**, in natural language. Rejected: text written by others would reach the invitee's model, and nothing would remain of "only me to be able to talk to my assistant" (spec #101, story 5).

## Consequences

- Story 5 of spec #101 becomes: only I give instructions to my assistant; it reveals nothing of me but free slots, to the colleagues I allowed.
- The invitee's side answers in code, without a model: an availability request costs the invitee no quota, reaches no model and is answered at once. What the invitee told their assistant, such as no meetings on Friday afternoons, does not count yet.
- On the organizer's side too, code alone matches the candidate slots against the organizer's free/busy. The organizer's model never sees them, and the organizer learns one free slot of the invitee per request.
- An invitee whose assistant cannot answer, or who has none, is not read at all. The proposal then rests on the organizer's calendar alone, and the invitee answers the invitation.
- Organizations other than the owner's are out of scope. The availability request is the format to carry across, should they come in.
